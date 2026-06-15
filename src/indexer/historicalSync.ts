import { ethers } from "ethers";
import { Campaign } from "../models/Campaign";
import { Donation } from "../models/Donation";
import { Proposal } from "../models/Proposal";
import { VerifiedOrg } from "../models/VerifiedOrg";
import { fetchCampaignMeta } from "./fetchCampaignMeta";

const CHARITY_CORE_FULL_ABI = [
  "function getCampaign(uint256) view returns (tuple(uint256,address,string,uint256,uint256,uint256,uint8,uint8,uint8,uint8,string,uint256,uint256))",
];

/** Alchemy free tier allows ~10 blocks per eth_getLogs; override via INDEXER_LOG_CHUNK_SIZE. */
const LOG_CHUNK_SIZE = Math.max(
  1,
  Number(process.env.INDEXER_LOG_CHUNK_SIZE || 10)
);

const CHUNK_DELAY_MS = Math.max(
  0,
  Number(process.env.INDEXER_CHUNK_DELAY_MS || 300)
);

const FILTER_DELAY_MS = Math.max(
  0,
  Number(process.env.INDEXER_FILTER_DELAY_MS || 500)
);

const MAX_RETRIES = Math.max(
  1,
  Number(process.env.INDEXER_MAX_RETRIES || 4)
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("-32005")
  );
}

async function queryFilterWithRetry(
  contract: ethers.Contract,
  filter: ethers.ContractEventName,
  start: number,
  end: number
): Promise<ethers.Log[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await contract.queryFilter(filter, start, end);
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt === MAX_RETRIES - 1) throw err;
      const delayMs = 1000 * 2 ** attempt;
      console.warn(
        `[Indexer] eth_getLogs rate limited (blocks ${start}-${end}), retry ${attempt + 1}/${MAX_RETRIES - 1} in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function queryFilterChunked(
  contract: ethers.Contract,
  filter: ethers.ContractEventName,
  fromBlock: number,
  toBlock: number,
  label: string
): Promise<ethers.Log[]> {
  const logs: ethers.Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    const end = Math.min(start + LOG_CHUNK_SIZE - 1, toBlock);
    const chunk = await queryFilterWithRetry(contract, filter, start, end);
    logs.push(...chunk);
    if ((end - fromBlock) % (LOG_CHUNK_SIZE * 100) < LOG_CHUNK_SIZE) {
      process.stdout.write(`\r[Indexer] Backfill ${label}: scanned through block ${end} (${logs.length} logs)   `);
    }
    if (end < toBlock && CHUNK_DELAY_MS > 0) {
      await sleep(CHUNK_DELAY_MS);
    }
  }
  if (toBlock > fromBlock) process.stdout.write("\n");
  console.log(`[Indexer] Backfill ${label}: ${logs.length} logs`);
  return logs;
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

  const campaignLogs = await queryFilterChunked(core, campaignFilter, fromBlock, toBlock, "campaigns");
  if (FILTER_DELAY_MS > 0) await sleep(FILTER_DELAY_MS);

  const donationLogs = await queryFilterChunked(vault, donationFilter, fromBlock, toBlock, "donations");
  if (FILTER_DELAY_MS > 0) await sleep(FILTER_DELAY_MS);

  const proposalLogs = await queryFilterChunked(dao, proposalFilter, fromBlock, toBlock, "proposals");
  if (FILTER_DELAY_MS > 0) await sleep(FILTER_DELAY_MS);

  const orgLogs = await queryFilterChunked(core, orgFilter, fromBlock, toBlock, "orgs");

  for (const log of campaignLogs) {
    const parsed = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) continue;
    const campaignId = Number(parsed.args[0]);
    const org = String(parsed.args[1]).toLowerCase();
    const goal = parsed.args[2];
    const deadline = Number(parsed.args[3]);

    const campaignData = await coreFull.getCampaign(campaignId);
    const metadataCID = campaignData[2];
    const meta = await fetchCampaignMeta(metadataCID, campaignId);

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

    const camp = await Campaign.findOne({ campaignId });
    if (camp) {
      const newRaised = (BigInt(camp.raisedAmount || "0") + BigInt(amount.toString())).toString();
      await Campaign.findOneAndUpdate({ campaignId }, { raisedAmount: newRaised });
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
      approvalStatus: "pending",
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
