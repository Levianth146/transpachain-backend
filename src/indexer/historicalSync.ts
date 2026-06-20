import { ethers } from "ethers";
import { Campaign } from "../models/Campaign";
import { Donation } from "../models/Donation";
import { Proposal } from "../models/Proposal";
import { VerifiedOrg } from "../models/VerifiedOrg";
import { fetchCampaignMeta } from "./fetchCampaignMeta";
import { netDonationAmount, withRpcFallback } from "../lib/rpcProvider";

const CHARITY_CORE_FULL_ABI = [
  "function getCampaign(uint256) view returns (tuple(uint256,address,string,uint256,uint256,uint256,uint8,uint8,uint8,uint8,string,uint256,uint256))",
];

const CHARITY_CORE_EVENTS_ABI = [
  "event CampaignCreated(uint256 indexed campaignId, address indexed org, uint256 goal, uint256 deadline)",
  "event OrgVerified(address indexed org, bool verified)",
];

const VAULT_EVENTS_ABI = [
  "event DonationReceived(uint256 indexed campaignId, address indexed donor, uint256 amount, uint8 tokenType)",
];

const DAO_EVENTS_ABI = [
  "event ProposalCreated(uint256 indexed proposalId, uint256 indexed campaignId, uint8 milestoneIndex, string proofCID, uint256 endBlock)",
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
  address: string,
  abi: readonly string[],
  filter: ethers.ContractEventName,
  fromBlock: number,
  toBlock: number,
  label: string
): Promise<ethers.Log[]> {
  return withRpcFallback(`backfill-${label}`, async (provider) => {
    const contract = new ethers.Contract(address, abi, provider);
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
  });
}

async function persistCampaigns(
  campaignLogs: ethers.Log[],
  core: ethers.Contract,
  coreFull: ethers.Contract
): Promise<number> {
  let persisted = 0;
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
        deadline,
        totalMilestones: Number(campaignData[7]),
        paymentToken: Number(campaignData[9]),
        status: 0,
        $setOnInsert: { raisedAmount: "0" },
      },
      { upsert: true }
    );
    persisted++;
  }
  return persisted;
}

async function persistDonations(
  donationLogs: ethers.Log[],
  vault: ethers.Contract,
  provider: ethers.JsonRpcProvider
): Promise<number> {
  let persisted = 0;
  for (const log of donationLogs) {
    const parsed = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) continue;
    const campaignId = Number(parsed.args[0]);
    const donor = String(parsed.args[1]).toLowerCase();
    const grossAmount = parsed.args[2];
    const tokenType = Number(parsed.args[3]);
    const txHash = log.transactionHash;
    const netAmount = netDonationAmount(BigInt(grossAmount.toString()));

    const exists = await Donation.findOne({ txHash });
    if (exists) continue;

    const block = await provider.getBlock(log.blockNumber);
    await Donation.create({
      campaignId,
      donor,
      amount: grossAmount.toString(),
      netAmount: netAmount.toString(),
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
      const newRaised = (BigInt(camp.raisedAmount || "0") + netAmount).toString();
      await Campaign.findOneAndUpdate({ campaignId }, { raisedAmount: newRaised });
    }
    persisted++;
  }
  return persisted;
}

async function persistProposals(
  proposalLogs: ethers.Log[],
  dao: ethers.Contract
): Promise<number> {
  let persisted = 0;
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
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      approvalStatus: "pending",
    });
    persisted++;
  }
  return persisted;
}

async function persistOrgs(
  orgLogs: ethers.Log[],
  core: ethers.Contract
): Promise<number> {
  let persisted = 0;
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
    persisted++;
  }
  return persisted;
}

/**
 * Backfill indexed data from DEPLOY_FROM_BLOCK using queryFilter.
 * Each stage fetches logs then immediately persists to Mongo so partial progress survives failures.
 * Returns total persisted event count across all stages.
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
): Promise<number> {
  const { core, vault, dao } = contracts;
  const coreAddress = process.env.CHARITY_CORE_ADDRESS!;
  const vaultAddress = process.env.DONATION_VAULT_ADDRESS!;
  const daoAddress = process.env.GOVERNANCE_DAO_ADDRESS!;

  console.log(`[Indexer] Backfill blocks ${fromBlock} → ${toBlock}`);

  const campaignFilter = core.filters.CampaignCreated();
  const donationFilter = vault.filters.DonationReceived();
  const proposalFilter = dao.filters.ProposalCreated();
  const orgFilter = core.filters.OrgVerified();

  const counts = { campaigns: 0, donations: 0, proposals: 0, orgs: 0 };

  try {
    const campaignLogs = await queryFilterChunked(
      coreAddress,
      CHARITY_CORE_EVENTS_ABI,
      campaignFilter,
      fromBlock,
      toBlock,
      "campaigns"
    );
    const coreFull = new ethers.Contract(coreAddress, CHARITY_CORE_FULL_ABI, provider);
    counts.campaigns = await persistCampaigns(campaignLogs, core, coreFull);
    console.log(`[Indexer] Backfill campaigns: persisted ${counts.campaigns}`);
  } catch (err) {
    console.error("[Indexer] Backfill campaigns stage failed:", err);
  }

  if (FILTER_DELAY_MS > 0) await sleep(FILTER_DELAY_MS);

  try {
    const donationLogs = await queryFilterChunked(
      vaultAddress,
      VAULT_EVENTS_ABI,
      donationFilter,
      fromBlock,
      toBlock,
      "donations"
    );
    counts.donations = await persistDonations(donationLogs, vault, provider);
    console.log(`[Indexer] Backfill donations: persisted ${counts.donations}`);
  } catch (err) {
    console.error("[Indexer] Backfill donations stage failed:", err);
  }

  if (FILTER_DELAY_MS > 0) await sleep(FILTER_DELAY_MS);

  try {
    const proposalLogs = await queryFilterChunked(
      daoAddress,
      DAO_EVENTS_ABI,
      proposalFilter,
      fromBlock,
      toBlock,
      "proposals"
    );
    counts.proposals = await persistProposals(proposalLogs, dao);
    console.log(`[Indexer] Backfill proposals: persisted ${counts.proposals}`);
  } catch (err) {
    console.error("[Indexer] Backfill proposals stage failed:", err);
  }

  if (FILTER_DELAY_MS > 0) await sleep(FILTER_DELAY_MS);

  try {
    const orgLogs = await queryFilterChunked(
      coreAddress,
      CHARITY_CORE_EVENTS_ABI,
      orgFilter,
      fromBlock,
      toBlock,
      "orgs"
    );
    counts.orgs = await persistOrgs(orgLogs, core);
    console.log(`[Indexer] Backfill orgs: persisted ${counts.orgs}`);
  } catch (err) {
    console.error("[Indexer] Backfill orgs stage failed:", err);
  }

  const totalEvents = counts.campaigns + counts.donations + counts.proposals + counts.orgs;
  console.log(
    `[Indexer] Backfill done: campaigns=${counts.campaigns} donations=${counts.donations} proposals=${counts.proposals} orgs=${counts.orgs} (total events=${totalEvents})`
  );
  return totalEvents;
}
