import { ethers } from "ethers";
import { Campaign } from "../models/Campaign";
import { Donation } from "../models/Donation";
import { Proposal } from "../models/Proposal";
import { VerifiedOrg } from "../models/VerifiedOrg";

const CHARITY_CORE_FULL_ABI = [
  "function getCampaign(uint256) view returns (tuple(uint256,address,string,uint256,uint256,uint256,uint8,uint8,uint8,uint8,string,uint256,uint256))",
];

async function fetchCampaignMeta(metadataCID: string) {
  let title = "",
    description = "",
    category = "general",
    imageUrl = "",
    orgName = "";
  if (!metadataCID) return { title, description, category, imageUrl, orgName };
  try {
    const ipfsRes = await fetch(`https://gateway.pinata.cloud/ipfs/${metadataCID}`);
    if (ipfsRes.ok) {
      const meta = (await ipfsRes.json()) as Record<string, string>;
      title = meta.title || "";
      description = meta.description || "";
      category = meta.category || "general";
      imageUrl = meta.imageUrl || "";
      orgName = meta.orgName || "";
    }
  } catch {
    /* ignore */
  }
  return { title, description, category, imageUrl, orgName };
}

/**
 * Backfill indexed data from DEPLOY_FROM_BLOCK using queryFilter.
 */
export async function runHistoricalBackfill(
  provider: ethers.JsonRpcProvider,
  contracts: {
    core: ethers.Contract;
    vault: ethers.Contract;
    dao: ethers.Contract;
  },
  fromBlock: number,
  toBlock: number
) {
  const { core, vault, dao } = contracts;
  const coreFull = new ethers.Contract(
    process.env.CHARITY_CORE_ADDRESS!,
    CHARITY_CORE_FULL_ABI,
    provider
  );

  console.log(`[Indexer] Backfill blocks ${fromBlock} → ${toBlock}`);

  const campaignFilter = core.filters.CampaignCreated();
  const donationFilter = vault.filters.DonationReceived();
  const proposalFilter = dao.filters.ProposalCreated();
  const orgFilter = core.filters.OrgVerified();

  const [campaignLogs, donationLogs, proposalLogs, orgLogs] = await Promise.all([
    core.queryFilter(campaignFilter, fromBlock, toBlock),
    vault.queryFilter(donationFilter, fromBlock, toBlock),
    dao.queryFilter(proposalFilter, fromBlock, toBlock),
    core.queryFilter(orgFilter, fromBlock, toBlock),
  ]);

  for (const log of campaignLogs) {
    const parsed = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) continue;
    const campaignId = Number(parsed.args[0]);
    const org = String(parsed.args[1]).toLowerCase();
    const goal = parsed.args[2];
    const deadline = Number(parsed.args[3]);

    const campaignData = await coreFull.getCampaign(campaignId);
    const metadataCID = campaignData[2];
    const meta = await fetchCampaignMeta(metadataCID);

    await Campaign.findOneAndUpdate(
      { campaignId },
      {
        campaignId,
        orgAddress: org,
        metadataCID,
        ...meta,
        goalAmount: goal.toString(),
        raisedAmount: "0",
        deadline,
        totalMilestones: Number(campaignData[7]),
        paymentToken: Number(campaignData[9]),
        status: 0,
      },
      { upsert: true }
    );
  }

  for (const log of donationLogs) {
    const parsed = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) continue;
    const campaignId = Number(parsed.args[0]);
    const donor = String(parsed.args[1]).toLowerCase();
    const amount = parsed.args[2];
    const tokenType = Number(parsed.args[3]);
    const txHash = log.transactionHash;

    const exists = await Donation.findOne({ txHash });
    if (exists) continue;

    const block = await provider.getBlock(log.blockNumber);
    await Donation.create({
      campaignId,
      donor,
      amount: amount.toString(),
      txHash,
      blockNumber: log.blockNumber,
      tokenType,
      timestamp: new Date(Number(block!.timestamp) * 1000),
    });

    const prior = await Donation.countDocuments({ campaignId, donor });
    if (prior <= 1) {
      await Campaign.findOneAndUpdate({ campaignId }, { $inc: { donorCount: 1 } });
    }
  }

  for (const log of proposalLogs) {
    const parsed = dao.interface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) continue;
    const proposalId = Number(parsed.args[0]);
    const exists = await Proposal.findOne({ proposalId });
    if (exists) continue;
    await Proposal.create({
      proposalId,
      campaignId: Number(parsed.args[1]),
      milestoneIndex: Number(parsed.args[2]),
      proofCID: parsed.args[3],
      endBlock: Number(parsed.args[4]),
      txHash: log.transactionHash,
    });
  }

  for (const log of orgLogs) {
    const parsed = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) continue;
    const org = String(parsed.args[0]).toLowerCase();
    const verified = Boolean(parsed.args[1]);
    await VerifiedOrg.findOneAndUpdate(
      { address: org },
      { address: org, verified, txHash: log.transactionHash, blockNumber: log.blockNumber },
      { upsert: true }
    );
  }

  console.log(
    `[Indexer] Backfill done: campaigns=${campaignLogs.length} donations=${donationLogs.length} proposals=${proposalLogs.length} orgs=${orgLogs.length}`
  );
}
