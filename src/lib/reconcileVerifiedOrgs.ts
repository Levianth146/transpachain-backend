import { ethers } from "ethers";
import { OrgProfile } from "../models/OrgProfile";
import { VerifiedOrg } from "../models/VerifiedOrg";
import { withRpcFallback } from "./rpcProvider";

const CHARITY_CORE_ABI = [
  "event OrgVerified(address indexed org, bool verified)",
  "function isOrgVerified(address org) view returns (bool)",
];

const LOG_CHUNK_SIZE = Math.max(1, Number(process.env.INDEXER_LOG_CHUNK_SIZE || 10));
const CHUNK_DELAY_MS = Math.max(0, Number(process.env.INDEXER_CHUNK_DELAY_MS || 300));
const MAX_RETRIES = Math.max(1, Number(process.env.INDEXER_MAX_RETRIES || 4));
const ORG_LOOKBACK_BLOCKS = Math.max(
  1_000,
  Number(process.env.RECONCILE_ORG_LOOKBACK_BLOCKS || 50_000)
);

let reconcileRunning = false;

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
        `[ReconcileOrgs] eth_getLogs rate limited (blocks ${start}-${end}), retry ${attempt + 1}/${MAX_RETRIES - 1} in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

export interface SyncVerifiedOrgsResult {
  mode: "full" | "incremental";
  fromBlock: number;
  toBlock: number;
  eventsProcessed: number;
  upserted: number;
  knownOrgsChecked: number;
  errors: string[];
}

function resolveFromBlock(toBlock: number): { fromBlock: number; mode: "full" | "incremental" } {
  const deployBlock = Number(process.env.DEPLOY_FROM_BLOCK || 0);
  const contractDeployBlock = Number(process.env.CONTRACT_DEPLOY_BLOCK || 11046235);

  if (deployBlock > 0) {
    return { fromBlock: deployBlock, mode: "full" };
  }

  return {
    fromBlock: Math.max(contractDeployBlock, toBlock - ORG_LOOKBACK_BLOCKS),
    mode: "incremental",
  };
}

async function collectKnownOrgAddresses(): Promise<string[]> {
  const [profiles, verified] = await Promise.all([
    OrgProfile.find({}, { orgAddress: 1 }).lean(),
    VerifiedOrg.find({}, { address: 1 }).lean(),
  ]);

  const addresses = new Set<string>();
  for (const profile of profiles) {
    if (profile.orgAddress) addresses.add(profile.orgAddress.toLowerCase());
  }
  for (const org of verified) {
    if (org.address) addresses.add(org.address.toLowerCase());
  }
  return [...addresses];
}

async function syncKnownOrgsViaContract(
  coreAddress: string
): Promise<{ checked: number; upserted: number; errors: string[] }> {
  const addresses = await collectKnownOrgAddresses();
  const result = { checked: 0, upserted: 0, errors: [] as string[] };

  if (addresses.length === 0) return result;

  for (const org of addresses) {
    try {
      const verified = await withRpcFallback(`isOrgVerified-${org}`, async (provider) => {
        const core = new ethers.Contract(coreAddress, CHARITY_CORE_ABI, provider);
        return Boolean(await core.isOrgVerified(org));
      });
      result.checked++;
      await VerifiedOrg.findOneAndUpdate(
        { address: org },
        { address: org, verified },
        { upsert: true }
      );
      result.upserted++;
    } catch (err) {
      result.errors.push(
        `${org}: ${String((err as { message?: string })?.message ?? err)}`
      );
    }
  }

  return result;
}

async function upsertOrgFromLog(
  coreAddress: string,
  log: ethers.Log
): Promise<void> {
  const core = new ethers.Contract(coreAddress, CHARITY_CORE_ABI, log.provider);
  const parsed = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
  if (!parsed) return;

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
}

/**
 * Re-scan OrgVerified logs and upsert into Mongo.
 * CharityCore uses non-enumerable AccessControl — org list must come from events.
 * When DEPLOY_FROM_BLOCK=0, scans only recent blocks plus isOrgVerified for known addresses.
 */
export async function syncVerifiedOrgsFromEvents(): Promise<SyncVerifiedOrgsResult> {
  const address = process.env.CHARITY_CORE_ADDRESS;

  const result: SyncVerifiedOrgsResult = {
    mode: "incremental",
    fromBlock: 0,
    toBlock: 0,
    eventsProcessed: 0,
    upserted: 0,
    knownOrgsChecked: 0,
    errors: [],
  };

  if (!address) {
    result.errors.push("CHARITY_CORE_ADDRESS not set");
    return result;
  }

  try {
    const toBlock = await withRpcFallback("sync-orgs-getBlockNumber", (p) => p.getBlockNumber());
    result.toBlock = toBlock;

    const { fromBlock, mode } = resolveFromBlock(toBlock);
    result.fromBlock = fromBlock;
    result.mode = mode;

    const knownSync = await syncKnownOrgsViaContract(address);
    result.knownOrgsChecked = knownSync.checked;
    result.upserted += knownSync.upserted;
    result.errors.push(...knownSync.errors);

    const logs = await withRpcFallback("sync-orgs-queryFilter", async (provider) => {
      const core = new ethers.Contract(address, CHARITY_CORE_ABI, provider);
      const filter = core.filters.OrgVerified();
      const collected: ethers.Log[] = [];

      for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
        const end = Math.min(start + LOG_CHUNK_SIZE - 1, toBlock);
        const chunk = await queryFilterWithRetry(core, filter, start, end);
        collected.push(...chunk);
        if (end < toBlock && CHUNK_DELAY_MS > 0) await sleep(CHUNK_DELAY_MS);
      }
      return collected;
    });

    result.eventsProcessed = logs.length;

    for (const log of logs) {
      try {
        await upsertOrgFromLog(address, log);
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

export function isVerifiedOrgReconcileRunning(): boolean {
  return reconcileRunning;
}

/** Fire-and-forget wrapper used by admin route; prevents overlapping runs. */
export function startVerifiedOrgReconcileInBackground(): boolean {
  if (reconcileRunning) return false;
  reconcileRunning = true;

  void syncVerifiedOrgsFromEvents()
    .then((result) => {
      console.log(
        `[ReconcileOrgs] Background complete (${result.mode}) blocks ${result.fromBlock}-${result.toBlock}: ` +
          `${result.eventsProcessed} events, ${result.knownOrgsChecked} known orgs, ${result.upserted} upserts` +
          (result.errors.length ? `, ${result.errors.length} error(s)` : "")
      );
      if (result.errors.length > 0) {
        console.warn("[ReconcileOrgs] Errors:", result.errors.slice(0, 5));
      }
    })
    .catch((err) => {
      console.error("[ReconcileOrgs] Background failed:", err);
    })
    .finally(() => {
      reconcileRunning = false;
    });

  return true;
}
