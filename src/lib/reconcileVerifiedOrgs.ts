import { ethers } from "ethers";
import { VerifiedOrg } from "../models/VerifiedOrg";
import { withRpcFallback } from "./rpcProvider";

const ORG_VERIFIED_ABI = [
  "event OrgVerified(address indexed org, bool verified)",
];

const LOG_CHUNK_SIZE = Math.max(1, Number(process.env.INDEXER_LOG_CHUNK_SIZE || 10));
const CHUNK_DELAY_MS = Math.max(0, Number(process.env.INDEXER_CHUNK_DELAY_MS || 300));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SyncVerifiedOrgsResult {
  fromBlock: number;
  toBlock: number;
  eventsProcessed: number;
  upserted: number;
  errors: string[];
}

/**
 * Re-scan OrgVerified logs and upsert into Mongo.
 * CharityCore uses non-enumerable AccessControl — org list must come from events.
 */
export async function syncVerifiedOrgsFromEvents(): Promise<SyncVerifiedOrgsResult> {
  const address = process.env.CHARITY_CORE_ADDRESS;
  const deployBlock = Number(process.env.DEPLOY_FROM_BLOCK || 0);
  const fallbackBlock = Number(process.env.CONTRACT_DEPLOY_BLOCK || 11046235);
  const fromBlock = deployBlock > 0 ? deployBlock : fallbackBlock;

  const result: SyncVerifiedOrgsResult = {
    fromBlock,
    toBlock: 0,
    eventsProcessed: 0,
    upserted: 0,
    errors: [],
  };

  if (!address) {
    result.errors.push("CHARITY_CORE_ADDRESS not set");
    return result;
  }

  try {
    const toBlock = await withRpcFallback("sync-orgs-getBlockNumber", (p) => p.getBlockNumber());
    result.toBlock = toBlock;

    const logs = await withRpcFallback("sync-orgs-queryFilter", async (provider) => {
      const core = new ethers.Contract(address, ORG_VERIFIED_ABI, provider);
      const filter = core.filters.OrgVerified();
      const collected: ethers.Log[] = [];

      for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
        const end = Math.min(start + LOG_CHUNK_SIZE - 1, toBlock);
        const chunk = await core.queryFilter(filter, start, end);
        collected.push(...chunk);
        if (end < toBlock && CHUNK_DELAY_MS > 0) await sleep(CHUNK_DELAY_MS);
      }
      return collected;
    });

    result.eventsProcessed = logs.length;

    for (const log of logs) {
      try {
        const core = new ethers.Contract(address, ORG_VERIFIED_ABI, log.provider);
        const parsed = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!parsed) continue;
        const org = String(parsed.args[0]).toLowerCase();
        await VerifiedOrg.findOneAndUpdate(
          { address: org },
          {
            address: org,
            verified: Boolean(parsed.args[1]),
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
          },
          { upsert: true }
        );
        result.upserted++;
      } catch (err) {
        result.errors.push(
          `log ${log.transactionHash}: ${String((err as { message?: string })?.message ?? err)}`
        );
      }
    }
  } catch (err) {
    result.errors.push(String((err as { message?: string })?.message ?? err));
  }

  return result;
}
