import { ethers } from "ethers";
import { OrgProfile } from "../models/OrgProfile";
import {
  getOrgReconcileState,
  saveOrgReconcileState,
} from "../models/OrgReconcileState";
import { VerifiedOrg } from "../models/VerifiedOrg";
import { withRpcFallback } from "./rpcProvider";

const CHARITY_CORE_ABI = [
  "event OrgVerified(address indexed org, bool verified)",
  "function isOrgVerified(address org) view returns (bool)",
];

const ORG_LOG_CHUNK_SIZE = Math.max(
  1,
  Number(process.env.RECONCILE_ORG_CHUNK_SIZE || 2000)
);
const ORG_CHUNK_DELAY_MS = Math.max(
  0,
  Number(process.env.RECONCILE_ORG_CHUNK_DELAY_MS || process.env.INDEXER_CHUNK_DELAY_MS || 50)
);
const MAX_RETRIES = Math.max(1, Number(process.env.INDEXER_MAX_RETRIES || 4));
const ORG_LOOKBACK_BLOCKS = Math.max(
  100,
  Number(process.env.RECONCILE_ORG_LOOKBACK_BLOCKS || 5_000)
);
const ORG_PROGRESS_EVERY_CHUNKS = Math.max(
  1,
  Number(process.env.RECONCILE_ORG_PROGRESS_EVERY_CHUNKS || 5)
);
/** When true (default), skip log scan after a completed full scan if isOrgVerified synced all known orgs and there are no new blocks. */
const ORG_FAST_PATH = process.env.RECONCILE_ORG_FAST_PATH !== "0";

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
  mode: "full" | "incremental" | "fast-path";
  fromBlock: number;
  toBlock: number;
  eventsProcessed: number;
  upserted: number;
  knownOrgsChecked: number;
  logScanSkipped: boolean;
  errors: string[];
}

interface ResolveScanRange {
  fromBlock: number;
  mode: "full" | "incremental";
  skipLogScan: boolean;
  fullScanComplete: boolean;
}

async function resolveScanRange(toBlock: number): Promise<ResolveScanRange> {
  const deployBlock = Number(process.env.DEPLOY_FROM_BLOCK || 0);
  const contractDeployBlock = Number(process.env.CONTRACT_DEPLOY_BLOCK || 11102718);
  const state = await getOrgReconcileState();

  if (deployBlock > 0) {
    return {
      fromBlock: deployBlock,
      mode: "full",
      skipLogScan: false,
      fullScanComplete: false,
    };
  }

  if (state?.fullScanComplete && state.lastOrgReconcileBlock >= toBlock) {
    return {
      fromBlock: toBlock + 1,
      mode: "incremental",
      skipLogScan: true,
      fullScanComplete: true,
    };
  }

  if (state?.fullScanComplete && state.lastOrgReconcileBlock > 0) {
    return {
      fromBlock: state.lastOrgReconcileBlock + 1,
      mode: "incremental",
      skipLogScan: false,
      fullScanComplete: true,
    };
  }

  return {
    fromBlock: Math.max(contractDeployBlock, toBlock - ORG_LOOKBACK_BLOCKS),
    mode: "incremental",
    skipLogScan: false,
    fullScanComplete: false,
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

  if (addresses.length === 0) {
    console.log("[ReconcileOrgs] No known org addresses to check on-chain");
    return result;
  }

  console.log(
    `[ReconcileOrgs] Checking ${addresses.length} known org address(es) via isOrgVerified...`
  );

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
      console.log(`[ReconcileOrgs] isOrgVerified ${org}: ${verified ? "verified" : "not verified"}`);
    } catch (err) {
      const message = String((err as { message?: string })?.message ?? err);
      result.errors.push(`${org}: ${message}`);
      console.warn(`[ReconcileOrgs] isOrgVerified ${org} failed: ${message}`);
    }
  }

  console.log(
    `[ReconcileOrgs] isOrgVerified complete: ${result.checked}/${addresses.length} checked, ${result.upserted} upserted` +
      (result.errors.length ? `, ${result.errors.length} error(s)` : "")
  );

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

function canSkipLogScan(
  scan: ResolveScanRange,
  toBlock: number,
  knownSync: { checked: number; errors: string[] }
): { skip: boolean; reason: string } {
  if (scan.skipLogScan) {
    return { skip: true, reason: "already reconciled through chain head" };
  }

  const noNewBlocks = scan.fromBlock > toBlock;
  if (noNewBlocks) {
    return { skip: true, reason: "no new blocks since last reconcile" };
  }

  if (!ORG_FAST_PATH || knownSync.errors.length > 0 || knownSync.checked === 0) {
    return { skip: false, reason: "" };
  }

  if (!scan.fullScanComplete) {
    return {
      skip: true,
      reason: "fast path: skipping initial lookback (isOrgVerified synced known orgs)",
    };
  }

  return { skip: false, reason: "" };
}

/**
 * Re-scan OrgVerified logs and upsert into Mongo.
 * CharityCore uses non-enumerable AccessControl — org list must come from events.
 * Primary path: isOrgVerified() for known addresses (fast). Log scan is incremental
 * from lastOrgReconcileBlock stored in Mongo, or a short lookback on first run.
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
    logScanSkipped: false,
    errors: [],
  };

  if (!address) {
    result.errors.push("CHARITY_CORE_ADDRESS not set");
    return result;
  }

  try {
    const toBlock = await withRpcFallback("sync-orgs-getBlockNumber", (p) => p.getBlockNumber());
    result.toBlock = toBlock;

    const scan = await resolveScanRange(toBlock);
    result.fromBlock = scan.fromBlock;
    result.mode = scan.mode;

    const blockSpan = Math.max(0, toBlock - scan.fromBlock + 1);
    console.log(
      `[ReconcileOrgs] Starting ${scan.mode} scan blocks ${scan.fromBlock}-${toBlock} ` +
        `(${blockSpan} blocks, chunk=${ORG_LOG_CHUNK_SIZE}, lookback=${ORG_LOOKBACK_BLOCKS}, ` +
        `persisted=${scan.fullScanComplete ? "yes" : "no"})`
    );

    const knownSync = await syncKnownOrgsViaContract(address);
    result.knownOrgsChecked = knownSync.checked;
    result.upserted += knownSync.upserted;
    result.errors.push(...knownSync.errors);

    const skipDecision = canSkipLogScan(scan, toBlock, knownSync);

    if (skipDecision.skip) {
      result.logScanSkipped = true;
      result.mode = "fast-path";
      await saveOrgReconcileState(toBlock, true);
      console.log(`[ReconcileOrgs] Skipping log scan (${skipDecision.reason})`);
    } else {
      const logs = await withRpcFallback("sync-orgs-queryFilter", async (provider) => {
        const core = new ethers.Contract(address, CHARITY_CORE_ABI, provider);
        const filter = core.filters.OrgVerified();
        const collected: ethers.Log[] = [];
        let chunkIndex = 0;

        for (let start = scan.fromBlock; start <= toBlock; start += ORG_LOG_CHUNK_SIZE) {
          const end = Math.min(start + ORG_LOG_CHUNK_SIZE - 1, toBlock);
          const chunk = await queryFilterWithRetry(core, filter, start, end);
          collected.push(...chunk);
          chunkIndex++;

          if (chunkIndex % ORG_PROGRESS_EVERY_CHUNKS === 0 || end >= toBlock) {
            console.log(
              `[ReconcileOrgs] Progress: scanned through block ${end} (${collected.length} OrgVerified log(s), chunk ${chunkIndex})`
            );
          }

          if (end < toBlock && ORG_CHUNK_DELAY_MS > 0) await sleep(ORG_CHUNK_DELAY_MS);
        }

        console.log(`[ReconcileOrgs] Log scan found ${collected.length} OrgVerified event(s)`);
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

      await saveOrgReconcileState(toBlock, true);
    }
  } catch (err) {
    result.errors.push(String((err as { message?: string })?.message ?? err));
  }

  console.log(
    `[ReconcileOrgs] Complete (${result.mode}) blocks ${result.fromBlock}-${result.toBlock}: ` +
      `${result.eventsProcessed} events, ${result.knownOrgsChecked} known orgs, ${result.upserted} upserts` +
      (result.logScanSkipped ? ", log scan skipped" : "") +
      (result.errors.length ? `, ${result.errors.length} error(s)` : "")
  );
  if (result.errors.length > 0) {
    console.warn("[ReconcileOrgs] Errors:", result.errors.slice(0, 5));
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
    .then(() => {
      console.log("[ReconcileOrgs] Background reconcile finished");
    })
    .catch((err) => {
      console.error("[ReconcileOrgs] Background failed:", err);
    })
    .finally(() => {
      reconcileRunning = false;
    });

  return true;
}
