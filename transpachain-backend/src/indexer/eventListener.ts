import { ethers } from "ethers";
import { Server as IOServer } from "socket.io";
import { Campaign } from "../models/Campaign";
import { Donation } from "../models/Donation";
import { Proposal } from "../models/Proposal";

// Minimal ABIs for event listening
const CHARITY_CORE_ABI = [
  "event CampaignCreated(uint256 indexed campaignId, address indexed org, uint256 goal, uint256 deadline)",
  "event CampaignStatusChanged(uint256 indexed campaignId, uint8 newStatus)",
];
const VAULT_ABI = [
  "event DonationReceived(uint256 indexed campaignId, address indexed donor, uint256 amount)",
  "event MilestoneProofSubmitted(uint256 indexed campaignId, uint8 milestoneIndex, string proofCID, uint256 proposalId)",
  "event FundsReleased(uint256 indexed campaignId, uint8 milestoneIndex, uint256 amount, address recipient)",
  "event RefundProcessed(uint256 indexed campaignId, address indexed donor, uint256 amount)",
];
const DAO_ABI = [
  "event ProposalCreated(uint256 indexed proposalId, uint256 indexed campaignId, uint8 milestoneIndex, string proofCID, uint256 endBlock)",
  "event VoteCast(uint256 indexed proposalId, address indexed voter, uint8 choice, uint256 weight)",
  "event ProposalQueued(uint256 indexed proposalId, uint256 executeAfter)",
  "event ProposalExecuted(uint256 indexed proposalId)",
];

export async function startEventListener(io: IOServer) {
  const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_SEPOLIA_URL);

  const core  = new ethers.Contract(process.env.CHARITY_CORE_ADDRESS!, CHARITY_CORE_ABI, provider);
  const vault = new ethers.Contract(process.env.DONATION_VAULT_ADDRESS!, VAULT_ABI, provider);
  const dao   = new ethers.Contract(process.env.GOVERNANCE_DAO_ADDRESS!, DAO_ABI, provider);

  // ─── CharityCore events ────────────────────────────────────

  core.on("CampaignCreated", async (campaignId, org, goal, deadline, event) => {
    console.log(`[Indexer] CampaignCreated #${campaignId}`);
    await Campaign.findOneAndUpdate(
      { campaignId: Number(campaignId) },
      {
        campaignId:      Number(campaignId),
        orgAddress:      org.toLowerCase(),
        metadataCID:     "",   // fetched separately from IPFS
        goalAmount:      goal.toString(),
        deadline:        Number(deadline),
        totalMilestones: 0,   // updated from contract read
      },
      { upsert: true, new: true }
    );
    io.emit("campaignCreated", { campaignId: Number(campaignId) });
  });

  // ─── DonationVault events ──────────────────────────────────

  vault.on("DonationReceived", async (campaignId, donor, amount, event) => {
    console.log(`[Indexer] DonationReceived campaign #${campaignId} from ${donor}`);

    const tx = await event.getTransaction();
    await Donation.create({
      campaignId:  Number(campaignId),
      donor:       donor.toLowerCase(),
      amount:      amount.toString(),
      txHash:      tx.hash,
      blockNumber: event.blockNumber,
    });

    await Campaign.findOneAndUpdate(
      { campaignId: Number(campaignId) },
      { $inc: { donorCount: 1 } }   // approximate — deduplicate in Phase 3
    );

    io.emit("donationReceived", {
      campaignId: Number(campaignId),
      donor,
      amount: amount.toString(),
    });
  });

  vault.on("FundsReleased", async (campaignId, milestoneIndex, amount, recipient, event) => {
    console.log(`[Indexer] FundsReleased campaign #${campaignId} milestone ${milestoneIndex}`);
    await Campaign.findOneAndUpdate(
      { campaignId: Number(campaignId) },
      { $inc: { completedMilestones: 1 } }
    );
    io.emit("fundsReleased", { campaignId: Number(campaignId), milestoneIndex });
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

  console.log("[Indexer] Listening to Sepolia events...");
}
