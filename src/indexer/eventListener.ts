import { ethers } from "ethers";
import { Server as IOServer } from "socket.io";
import { Campaign } from "../models/Campaign";
import { Donation } from "../models/Donation";
import { Proposal } from "../models/Proposal";
import { VerifiedOrg } from "../models/VerifiedOrg";
import { fetchCampaignMeta } from "./fetchCampaignMeta";
import { runHistoricalBackfill } from "./historicalSync";
import {
  getIndexerStatus,
  markBackfillComplete,
  markIndexerError,
  markPollSuccess,
  setBackfillFromBlock,
  setIndexerPhase,
} from "./indexerStatus";
import { getProvider, netDonationAmount, withRpcFallback } from "../lib/rpcProvider";
import { reconcileCampaignRaisedAmounts } from "../lib/reconcileCampaigns";

const CHARITY_CORE_ABI = [
  "event CampaignCreated(uint256 indexed campaignId, address indexed org, uint256 goal, uint256 deadline)",
  "event CampaignStatusChanged(uint256 indexed campaignId, uint8 newStatus)",
  "event CampaignCancelled(uint256 indexed campaignId, address indexed cancelledBy, uint256 cancelledAt)",
  "event CampaignFinalized(uint256 indexed campaignId, uint8 finalStatus)",
  "event OrgVerified(address indexed org, bool verified)",
  "event DeadlineExtended(uint256 indexed campaignId, uint256 newDeadline)",
];
const CHARITY_CORE_FULL_ABI = [
  "function getCampaign(uint256) view returns (tuple(uint256,address,string,uint256,uint256,uint256,uint8,uint8,uint8,uint8,string,uint256,uint256))",
];
const VAULT_ABI = [
  "event DonationReceived(uint256 indexed campaignId, address indexed donor, uint256 amount, uint8 tokenType)",
  "event FundsReleased(uint256 indexed campaignId, uint8 milestoneIndex, uint256 amount, address recipient)",
  "event RefundProcessed(uint256 indexed campaignId, address indexed donor, uint256 amount)",
];
const DAO_ABI = [
  "event ProposalCreated(uint256 indexed proposalId, uint256 indexed campaignId, uint8 milestoneIndex, string proofCID, uint256 endBlock)",
  "event VoteCast(uint256 indexed proposalId, address indexed voter, uint8 choice, uint256 weight)",
  "event ProposalQueued(uint256 indexed proposalId, uint256 executeAfter)",
  "event ProposalExecuted(uint256 indexed proposalId)",
  "event ProposalDefeated(uint256 indexed proposalId)",
  "event ProposalResubmitted(uint256 indexed newProposalId, uint256 indexed oldProposalId)",
  "event ProposalClosed(uint256 indexed proposalId, address indexed closedBy, string reason)",
];

const POLL_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.INDEXER_POLL_INTERVAL_MS || 15000)
);

const LOG_CHUNK_SIZE = Math.max(1, Number(process.env.INDEXER_LOG_CHUNK_SIZE || 10));
const CHUNK_DELAY_MS = Math.max(0, Number(process.env.INDEXER_CHUNK_DELAY_MS || 300));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryFilterChunked(
  contract: ethers.Contract,
  filter: ethers.ContractEventName,
  fromBlock: number,
  toBlock: number
): Promise<ethers.Log[]> {
  const logs: ethers.Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    const end = Math.min(start + LOG_CHUNK_SIZE - 1, toBlock);
    const chunk = await contract.queryFilter(filter, start, end);
    logs.push(...chunk);
    if (end < toBlock && CHUNK_DELAY_MS > 0) await sleep(CHUNK_DELAY_MS);
  }
  return logs;
}

async function handleCampaignCreated(
  log: ethers.Log,
  core: ethers.Contract,
  provider: ethers.JsonRpcProvider,
  io: IOServer
) {
  const parsed = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
  if (!parsed) return;
  const campaignId = Number(parsed.args[0]);
  const org = String(parsed.args[1]).toLowerCase();
  const goal = parsed.args[2];
  const deadline = Number(parsed.args[3]);

  const coreFull = new ethers.Contract(process.env.CHARITY_CORE_ADDRESS!, CHARITY_CORE_FULL_ABI, provider);
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
  io.emit("campaignCreated", { campaignId });
}

async function handleDonationReceived(log: ethers.Log, vault: ethers.Contract, io: IOServer) {
  const parsed = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
  if (!parsed) return;
  const campaignId = Number(parsed.args[0]);
  const donor = String(parsed.args[1]).toLowerCase();
  const grossAmount = parsed.args[2];
  const tokenType = Number(parsed.args[3]);
  const txHash = log.transactionHash;
  const netAmount = netDonationAmount(BigInt(grossAmount.toString()));

  const exists = await Donation.findOne({ txHash });
  if (exists) return;

  const block = await log.provider!.getBlock(log.blockNumber);
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

  const existingDonation = await Donation.findOne({ campaignId, donor, txHash: { $ne: txHash } });
  if (!existingDonation) {
    await Campaign.findOneAndUpdate({ campaignId }, { $inc: { donorCount: 1 } });
  }

  const camp = await Campaign.findOne({ campaignId });
  if (camp) {
    const newRaised = (BigInt(camp.raisedAmount || "0") + netAmount).toString();
    await Campaign.findOneAndUpdate({ campaignId }, { raisedAmount: newRaised });
  }

  io.emit("donationReceived", {
    campaignId,
    donor,
    amount: grossAmount.toString(),
    netAmount: netAmount.toString(),
    tokenType,
  });
  io.emit("campaignUpdated", { campaignId });
}

async function processPollRange(
  provider: ethers.JsonRpcProvider,
  contracts: { core: ethers.Contract; vault: ethers.Contract; dao: ethers.Contract },
  fromBlock: number,
  toBlock: number,
  io: IOServer
): Promise<number> {
  const { core, vault, dao } = contracts;
  let processed = 0;

  const handlers: Array<{
    contract: ethers.Contract;
    filter: ethers.ContractEventName;
    fn: (log: ethers.Log) => Promise<void>;
  }> = [
    {
      contract: core,
      filter: core.filters.CampaignCreated(),
      fn: (log) => handleCampaignCreated(log, core, provider, io),
    },
    {
      contract: core,
      filter: core.filters.CampaignCancelled(),
      fn: async (log) => {
        const p = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        await Campaign.findOneAndUpdate(
          { campaignId: Number(p.args[0]) },
          { status: 3, cancelledAt: Number(p.args[2]) }
        );
        io.emit("campaignCancelled", { campaignId: Number(p.args[0]) });
      },
    },
    {
      contract: core,
      filter: core.filters.CampaignStatusChanged(),
      fn: async (log) => {
        const p = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        await Campaign.findOneAndUpdate({ campaignId: Number(p.args[0]) }, { status: Number(p.args[1]) });
        io.emit("campaignStatusChanged", { campaignId: Number(p.args[0]), status: Number(p.args[1]) });
      },
    },
    {
      contract: core,
      filter: core.filters.CampaignFinalized(),
      fn: async (log) => {
        const p = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        await Campaign.findOneAndUpdate({ campaignId: Number(p.args[0]) }, { status: Number(p.args[1]) });
        io.emit("campaignFinalized", { campaignId: Number(p.args[0]), status: Number(p.args[1]) });
      },
    },
    {
      contract: core,
      filter: core.filters.DeadlineExtended(),
      fn: async (log) => {
        const p = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        await Campaign.findOneAndUpdate({ campaignId: Number(p.args[0]) }, { deadline: Number(p.args[1]) });
        io.emit("deadlineExtended", { campaignId: Number(p.args[0]), deadline: Number(p.args[1]) });
      },
    },
    {
      contract: core,
      filter: core.filters.OrgVerified(),
      fn: async (log) => {
        const p = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        const org = String(p.args[0]).toLowerCase();
        await VerifiedOrg.findOneAndUpdate(
          { address: org },
          { address: org, verified: Boolean(p.args[1]), txHash: log.transactionHash, blockNumber: log.blockNumber },
          { upsert: true }
        );
        io.emit("orgVerified", { org, verified: Boolean(p.args[1]) });
      },
    },
    {
      contract: vault,
      filter: vault.filters.DonationReceived(),
      fn: (log) => handleDonationReceived(log, vault, io),
    },
    {
      contract: vault,
      filter: vault.filters.FundsReleased(),
      fn: async (log) => {
        const p = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        await Campaign.findOneAndUpdate({ campaignId: Number(p.args[0]) }, { $inc: { completedMilestones: 1 } });
        io.emit("fundsReleased", { campaignId: Number(p.args[0]), milestoneIndex: Number(p.args[1]) });
      },
    },
    {
      contract: vault,
      filter: vault.filters.RefundProcessed(),
      fn: async (log) => {
        const p = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        await Donation.updateMany(
          { campaignId: Number(p.args[0]), donor: String(p.args[1]).toLowerCase() },
          { status: "refunded" }
        );
        io.emit("refundProcessed", {
          campaignId: Number(p.args[0]),
          donor: String(p.args[1]),
          amount: p.args[2].toString(),
        });
      },
    },
    {
      contract: dao,
      filter: dao.filters.ProposalCreated(),
      fn: async (log) => {
        const p = dao.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        const proposalId = Number(p.args[0]);
        const exists = await Proposal.findOne({ proposalId });
        if (exists) return;
        await Proposal.create({
          proposalId,
          campaignId: Number(p.args[1]),
          milestoneIndex: Number(p.args[2]),
          proofCID: p.args[3],
          endBlock: Number(p.args[4]),
          txHash: log.transactionHash,
          approvalStatus: "pending",
        });
        io.emit("proposalCreated", { proposalId, campaignId: Number(p.args[1]) });
      },
    },
    {
      contract: dao,
      filter: dao.filters.VoteCast(),
      fn: async (log) => {
        const p = dao.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        const choice = p.args[2];
        const weight = p.args[3];
        const update =
          choice === 1n
            ? { $inc: { forVotes: Number(weight) } }
            : choice === 0n
            ? { $inc: { againstVotes: Number(weight) } }
            : { $inc: { abstainVotes: Number(weight) } };
        await Proposal.findOneAndUpdate({ proposalId: Number(p.args[0]) }, update);
        io.emit("voteCast", {
          proposalId: Number(p.args[0]),
          voter: String(p.args[1]),
          choice: Number(choice),
          weight: weight.toString(),
        });
      },
    },
    {
      contract: dao,
      filter: dao.filters.ProposalQueued(),
      fn: async (log) => {
        const p = dao.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        await Proposal.findOneAndUpdate({ proposalId: Number(p.args[0]) }, { state: 3, executeAfter: Number(p.args[1]) });
        io.emit("proposalQueued", { proposalId: Number(p.args[0]) });
      },
    },
    {
      contract: dao,
      filter: dao.filters.ProposalExecuted(),
      fn: async (log) => {
        const p = dao.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        await Proposal.findOneAndUpdate({ proposalId: Number(p.args[0]) }, { state: 4 });
        io.emit("proposalExecuted", { proposalId: Number(p.args[0]) });
      },
    },
    {
      contract: dao,
      filter: dao.filters.ProposalDefeated(),
      fn: async (log) => {
        const p = dao.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        await Proposal.findOneAndUpdate({ proposalId: Number(p.args[0]) }, { state: 2 });
        io.emit("proposalDefeated", { proposalId: Number(p.args[0]) });
      },
    },
    {
      contract: dao,
      filter: dao.filters.ProposalResubmitted(),
      fn: async (log) => {
        const p = dao.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        await Proposal.findOneAndUpdate({ proposalId: Number(p.args[1]) }, { state: 2 });
        io.emit("proposalResubmitted", {
          newProposalId: Number(p.args[0]),
          oldProposalId: Number(p.args[1]),
        });
      },
    },
    {
      contract: dao,
      filter: dao.filters.ProposalClosed(),
      fn: async (log) => {
        const p = dao.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!p) return;
        await Proposal.findOneAndUpdate(
          { proposalId: Number(p.args[0]) },
          {
            state: 5,
            closedByAdmin: true,
            closedReason: String(p.args[2]),
            closedAt: new Date(),
            approvalStatus: "rejected",
          }
        );
        io.emit("proposalClosed", {
          proposalId: Number(p.args[0]),
          closedBy: String(p.args[1]),
          reason: String(p.args[2]),
        });
      },
    },
  ];

  for (const { contract, filter, fn } of handlers) {
    try {
      const logs = await queryFilterChunked(contract, filter, fromBlock, toBlock);
      for (const log of logs) {
        try {
          await fn(log);
          processed++;
        } catch (err) {
          console.error("[Indexer] Event handler error:", err);
        }
      }
    } catch (err) {
      console.error("[Indexer] queryFilter error:", err);
    }
  }

  return processed;
}

async function pollLoop(
  provider: ethers.JsonRpcProvider,
  contracts: { core: ethers.Contract; vault: ethers.Contract; dao: ethers.Contract },
  io: IOServer,
  startBlock: number
) {
  let lastBlock = startBlock;
  console.log(`[Indexer] Polling every ${POLL_INTERVAL_MS}ms from block ${lastBlock + 1} (no eth_newFilter subscriptions)`);

  for (;;) {
    try {
      const current = await withRpcFallback("getBlockNumber", (p) => p.getBlockNumber());
      if (current > lastBlock) {
        const processed = await processPollRange(provider, contracts, lastBlock + 1, current, io);
        lastBlock = current;
        markPollSuccess(current, processed);
        if (processed > 0) {
          console.log(`[Indexer] Poll blocks ${lastBlock - processed}-${current}: ${processed} events`);
        }
      }
    } catch (err) {
      markIndexerError(err);
      console.error("[Indexer] Poll cycle failed — will retry:", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function startEventListener(io: IOServer) {
  setIndexerPhase("backfill");

  const provider = getProvider();
  const core = new ethers.Contract(process.env.CHARITY_CORE_ADDRESS!, CHARITY_CORE_ABI, provider);
  const vault = new ethers.Contract(process.env.DONATION_VAULT_ADDRESS!, VAULT_ABI, provider);
  const dao = new ethers.Contract(process.env.GOVERNANCE_DAO_ADDRESS!, DAO_ABI, provider);
  const contracts = { core, vault, dao };

  const fromBlock = Number(process.env.DEPLOY_FROM_BLOCK || 0);
  let startPollBlock = fromBlock > 0 ? fromBlock - 1 : 0;

  if (fromBlock > 0) {
    setBackfillFromBlock(fromBlock);
    try {
      const current = await withRpcFallback("getBlockNumber", (p) => p.getBlockNumber());
      const backfillEvents = await runHistoricalBackfill(provider, contracts, fromBlock, current);
      startPollBlock = current;
      markBackfillComplete(current, backfillEvents);
      const reconcile = await reconcileCampaignRaisedAmounts();
      if (reconcile.updated > 0) {
        console.log(`[Indexer] Reconciled raisedAmount for ${reconcile.updated}/${reconcile.checked} campaigns`);
      }
      if (reconcile.errors.length > 0) {
        console.warn("[Indexer] Reconcile errors:", reconcile.errors.slice(0, 5));
      }
      console.log(`[Indexer] Backfill complete — set DEPLOY_FROM_BLOCK=0 to skip on next restart`);
    } catch (err) {
      markIndexerError(err);
      console.error(
        "[Indexer] Historical backfill failed — live polling continues. " +
          "After sync set DEPLOY_FROM_BLOCK=0; tune INDEXER_LOG_CHUNK_SIZE on free tier:",
        err
      );
      try {
        startPollBlock = await withRpcFallback("getBlockNumber", (p) => p.getBlockNumber());
      } catch {
        startPollBlock = fromBlock - 1;
      }
    }
  } else {
    try {
      startPollBlock = await withRpcFallback("getBlockNumber", (p) => p.getBlockNumber());
      markBackfillComplete(startPollBlock);
    } catch (err) {
      markIndexerError(err);
    }
  }

  setIndexerPhase("polling");
  void pollLoop(provider, contracts, io, startPollBlock).catch((err) => {
    markIndexerError(err);
    console.error("[Indexer] Poll loop exited:", err);
  });

  console.log("[Indexer] Started block polling on Sepolia");
}

export { getIndexerStatus };
