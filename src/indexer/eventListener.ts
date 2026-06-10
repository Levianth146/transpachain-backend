import { ethers } from "ethers";
import { Server as IOServer } from "socket.io";
import { Campaign } from "../models/Campaign";
import { Donation } from "../models/Donation";
import { Proposal } from "../models/Proposal";
import { VerifiedOrg }  from "../models/VerifiedOrg";
import { fetchCampaignMeta } from "./fetchCampaignMeta";

// Minimal ABIs for event listening
const CHARITY_CORE_ABI = [
  "event CampaignCreated(uint256 indexed campaignId, address indexed org, uint256 goal, uint256 deadline)",
  "event CampaignStatusChanged(uint256 indexed campaignId, uint8 newStatus)",
  "event CampaignCancelled(uint256 indexed campaignId, address indexed cancelledBy, uint256 cancelledAt)",
  "event CampaignFinalized(uint256 indexed campaignId, uint8 finalStatus)",
  "event OrgVerified(address indexed org, bool verified)",
  "event DeadlineExtended(uint256 indexed campaignId, uint256 newDeadline)"
];
const VAULT_ABI = [
  "event DonationReceived(uint256 indexed campaignId, address indexed donor, uint256 amount, uint8 tokenType)",
  "event MilestoneProofSubmitted(uint256 indexed campaignId, uint8 milestoneIndex, string proofCID, uint256 proposalId)",
  "event FundsReleased(uint256 indexed campaignId, uint8 milestoneIndex, uint256 amount, address recipient)",
  "event RefundProcessed(uint256 indexed campaignId, address indexed donor, uint256 amount)",
  "event PlatformFeeCollected(uint256 indexed campaignId, uint256 feeAmount)",
  "event TreasuryUpdated(address newTreasury)",
  "event MaxRefundPeriodUpdated(uint256 newPeriod)",
  "event EmergencyRefundBatch(uint256 indexed campaignId, uint256 donorCount, uint256 totalAmount)",
];
const DAO_ABI = [
  "event ProposalCreated(uint256 indexed proposalId, uint256 indexed campaignId, uint8 milestoneIndex, string proofCID, uint256 endBlock)",
  "event VoteCast(uint256 indexed proposalId, address indexed voter, uint8 choice, uint256 weight)",
  "event ProposalQueued(uint256 indexed proposalId, uint256 executeAfter)",
  "event ProposalExecuted(uint256 indexed proposalId)",
  "event ProposalDefeated(uint256 indexed proposalId)",
  "event ProposalResubmitted(uint256 indexed newProposalId, uint256 indexed oldProposalId)",
];
 
export async function startEventListener(io: IOServer) {
  const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_SEPOLIA_URL);
 
  const core  = new ethers.Contract(process.env.CHARITY_CORE_ADDRESS!, CHARITY_CORE_ABI, provider);
  const vault = new ethers.Contract(process.env.DONATION_VAULT_ADDRESS!, VAULT_ABI, provider);
  const dao   = new ethers.Contract(process.env.GOVERNANCE_DAO_ADDRESS!, DAO_ABI, provider);

  const fromBlock = Number(process.env.DEPLOY_FROM_BLOCK || 0);
  if (fromBlock > 0) {
    try {
      const current = await provider.getBlockNumber();
      const { runHistoricalBackfill } = await import("./historicalSync");
      await runHistoricalBackfill(provider, { core, vault, dao }, fromBlock, current);
    } catch (err) {
      console.error(
        "[Indexer] Historical backfill failed — live indexing continues. " +
          "Use deploy block for DEPLOY_FROM_BLOCK or INDEXER_LOG_CHUNK_SIZE=10 on Alchemy free:",
        err
      );
    }
  }
 
  // ─── CharityCore events ────────────────────────────────────
 
  core.on("CampaignCreated", async (campaignId, org, goal, deadline, event) => {
    console.log(`[Indexer] CampaignCreated #${campaignId}`);
 
    const CHARITY_CORE_FULL_ABI = [
      "function getCampaign(uint256) view returns (tuple(uint256,address,string,uint256,uint256,uint256,uint8,uint8,uint8,uint8,string,uint256,uint256))"
    ];
    const coreContract = new ethers.Contract(process.env.CHARITY_CORE_ADDRESS!, CHARITY_CORE_FULL_ABI, provider);
    const campaignData = await coreContract.getCampaign(Number(campaignId));
    const metadataCID = campaignData[2];
 
    const meta = await fetchCampaignMeta(metadataCID, Number(campaignId));
    const totalMilestones = Number(campaignData[7]);
    const paymentToken = Number(campaignData[9]);

    await Campaign.findOneAndUpdate(
      { campaignId: Number(campaignId) },
      {
        campaignId:      Number(campaignId),
        orgAddress:      org.toLowerCase(),
        metadataCID,
        ...meta,
        goalAmount:      goal.toString(),
        raisedAmount:    "0",
        deadline:        Number(deadline),
        totalMilestones,
        paymentToken,
        status:          0,
      },
      { upsert: true, new: true }
    );
    io.emit("campaignCreated", { campaignId: Number(campaignId) });
  });
 
  core.on("CampaignCancelled", async (campaignId, cancelledBy, cancelledAt, event) => {
    console.log(`[Indexer] CampaignCancelled #${campaignId}`);
    await Campaign.findOneAndUpdate(
      { campaignId: Number(campaignId) },
      { status: 3, cancelledAt: Number(cancelledAt) }
    );
    io.emit("campaignCancelled", { campaignId: Number(campaignId) });
  });
 
  core.on("CampaignStatusChanged", async (campaignId, newStatus) => {
    console.log(`[Indexer] CampaignStatusChanged #${campaignId} status = ${newStatus}`);
    await Campaign.findOneAndUpdate(
      { campaignId: Number(campaignId) },
      { status: Number(newStatus) }
    );
    io.emit("campaignStatusChanged", { campaignId: Number(campaignId), status: Number(newStatus) });
  });

  core.on("CampaignFinalized", async (campaignId, finalStatus, event) => {
    console.log(`[Indexer] CampaignFinalized #${campaignId} status = ${finalStatus}`);
    await Campaign.findOneAndUpdate(
      { campaignId: Number(campaignId) },
      { status: Number(finalStatus) }
    );
    io.emit("campaignFinalized", { campaignId: Number(campaignId), status: Number(finalStatus) });
  });

  core.on("DeadlineExtended", async (campaignId, newDeadline) => {
    console.log(`[Indexer] DeadlineExtended #${campaignId}`);
    await Campaign.findOneAndUpdate(
      { campaignId: Number(campaignId) },
      { deadline: Number(newDeadline) }
    );
    io.emit("deadlineExtended", { campaignId: Number(campaignId), deadline: Number(newDeadline) });
  });
 
  // ─── OrgVerified ────────────────────────────────────
  core.on("OrgVerified", async (org: string, verified: boolean, event: ethers.EventLog) => {
    console.log(`[Indexer] OrgVerified ${org} verified=${verified}`);
    try {
      const tx = await event.getTransaction();
      await VerifiedOrg.findOneAndUpdate(
        { address: org.toLowerCase() },
        {
          address:     org.toLowerCase(),
          verified,
          txHash:      tx.hash,
          blockNumber: event.blockNumber,
        },
        { upsert: true, new: true }
      );
      io.emit("orgVerified", { org, verified });
    } catch (e) {
      console.error("[Indexer] OrgVerified error:", e);
    }
  });
 
  // ─── DonationVault events ──────────────────────────────────
 
  vault.on("DonationReceived", async (campaignId, donor, amount, tokenType, event) => {
    console.log(`[Indexer] DonationReceived campaign #${campaignId} from ${donor}`);
 
    const tx = await event.getTransaction();
    const existingDonation = await Donation.findOne({ campaignId: Number(campaignId), donor: donor.toLowerCase() });
    const block = await event.getBlock();
 
    await Donation.create({
      campaignId:  Number(campaignId),
      donor:       donor.toLowerCase(),
      amount:      amount.toString(),
      txHash:      tx.hash,
      blockNumber: event.blockNumber,
      tokenType:   Number(tokenType),
      timestamp:   new Date(Number(block.timestamp) * 1000),
    });
 
    if (!existingDonation) {
      await Campaign.findOneAndUpdate(
        { campaignId: Number(campaignId) },
        { $inc: { donorCount: 1 } }
      );
    }

    const camp = await Campaign.findOne({ campaignId: Number(campaignId) });
    if (camp) {
      const newRaised = (BigInt(camp.raisedAmount || "0") + BigInt(amount.toString())).toString();
      await Campaign.findOneAndUpdate(
        { campaignId: Number(campaignId) },
        { raisedAmount: newRaised }
      );
    }

    io.emit("donationReceived", {
      campaignId: Number(campaignId),
      donor,
      amount: amount.toString(),
      tokenType: Number(tokenType),
    });
    io.emit("campaignUpdated", { campaignId: Number(campaignId) });
  });
 
  vault.on("FundsReleased", async (campaignId, milestoneIndex, amount, recipient, event) => {
    console.log(`[Indexer] FundsReleased campaign #${campaignId} milestone ${milestoneIndex}`);
    await Campaign.findOneAndUpdate(
      { campaignId: Number(campaignId) },
      { $inc: { completedMilestones: 1 } }
    );
    io.emit("fundsReleased", { campaignId: Number(campaignId), milestoneIndex });
  });
 
  vault.on("RefundProcessed", async (campaignId, donor, amount, event) => {
    console.log(`[Indexer] RefundProcessed campaign #${campaignId} donor ${donor}`);
    await Donation.updateMany(
      { campaignId: Number(campaignId), donor: donor.toLowerCase() },
      { status: "refunded" }
    );
    io.emit("refundProcessed", { campaignId: Number(campaignId), donor, amount: amount.toString() });
  });
 
  // ─── GovernanceDAO events ──────────────────────────────────
 
  dao.on("ProposalCreated", async (proposalId, campaignId, milestoneIndex, proofCID, endBlock, event) => {
    console.log(`[Indexer] ProposalCreated #${proposalId}`);
    const tx = await event.getTransaction();
    await Proposal.create({
      proposalId:     Number(proposalId),
      campaignId:     Number(campaignId),
      milestoneIndex: Number(milestoneIndex),
      proofCID,
      endBlock:       Number(endBlock),
      txHash:         tx.hash,
      approvalStatus: "pending",
    });
    io.emit("proposalCreated", { proposalId: Number(proposalId), campaignId: Number(campaignId) });
  });
 
  dao.on("ProposalQueued", async (proposalId, executeAfter) => {
    await Proposal.findOneAndUpdate({ proposalId: Number(proposalId) }, { state: 3, executeAfter: Number(executeAfter) });
    io.emit("proposalQueued", { proposalId: Number(proposalId) });
  });
 
  dao.on("ProposalExecuted", async (proposalId) => {
    await Proposal.findOneAndUpdate({ proposalId: Number(proposalId) }, { state: 4 });
    io.emit("proposalExecuted", { proposalId: Number(proposalId) });
  });
 
  dao.on("VoteCast", async (proposalId, voter, choice, weight, event) => {
    console.log(`[Indexer] VoteCast proposal #${proposalId} by ${voter}`);
    const update = choice === 1n
      ? { $inc: { forVotes: Number(weight) } }
      : choice === 0n
      ? { $inc: { againstVotes: Number(weight) } }
      : { $inc: { abstainVotes: Number(weight) } };
    await Proposal.findOneAndUpdate({ proposalId: Number(proposalId) }, update);
    io.emit("voteCast", { proposalId: Number(proposalId), voter, choice: Number(choice), weight: weight.toString() });
  });
 
  dao.on("ProposalDefeated", async (proposalId) => {
    await Proposal.findOneAndUpdate({ proposalId: Number(proposalId) }, { state: 2 });
    io.emit("proposalDefeated", { proposalId: Number(proposalId) });
  });

  dao.on("ProposalResubmitted", async (newProposalId, oldProposalId) => {
    await Proposal.findOneAndUpdate({ proposalId: Number(oldProposalId) }, { state: 2 });
    io.emit("proposalResubmitted", {
      newProposalId: Number(newProposalId),
      oldProposalId: Number(oldProposalId),
    });
  });

  console.log("[Indexer] Listening to Sepolia events...");
}
