import { FilterQuery } from "mongoose";
import { ethers } from "ethers";
import { Donation, IDonation } from "../models/Donation";
import { withRpcFallback } from "./rpcProvider";

const CHARITY_CORE_ABI = ["function totalCampaigns() view returns (uint256)"];

/** Block floor for the current CharityCore deployment (0 = no filter). */
export function getDeployFromBlock(): number {
  return Number(process.env.DEPLOY_FROM_BLOCK || 0);
}

export async function getOnChainTotalCampaigns(): Promise<number> {
  const address = process.env.CHARITY_CORE_ADDRESS;
  if (!address) return 0;

  return withRpcFallback("indexedScope-totalCampaigns", async (provider) => {
    const core = new ethers.Contract(address, CHARITY_CORE_ABI, provider);
    return Number(await core.totalCampaigns());
  });
}

/**
 * Mongo filter for donations belonging to the current on-chain deployment.
 * Requires blockNumber >= DEPLOY_FROM_BLOCK and campaignId within 1..totalCampaigns.
 * When totalCampaigns is 0, no donations match (empty $in).
 */
export function deploymentDonationFilter(onChainTotal: number): FilterQuery<IDonation> {
  const filter: FilterQuery<IDonation> = {};
  const deployBlock = getDeployFromBlock();

  if (deployBlock > 0) {
    filter.blockNumber = { $gte: deployBlock };
  }

  if (onChainTotal <= 0) {
    filter.campaignId = { $in: [] as number[] };
  } else {
    filter.campaignId = { $gte: 1, $lte: onChainTotal };
  }

  return filter;
}

/** Inverse of deploymentDonationFilter — stale rows from prior deploys or orphan campaign ids. */
export function orphanDonationFilter(onChainTotal: number): FilterQuery<IDonation> {
  const deployBlock = getDeployFromBlock();
  const or: FilterQuery<IDonation>[] = [];

  if (deployBlock > 0) {
    or.push({ blockNumber: { $lt: deployBlock } });
  }

  if (onChainTotal <= 0) {
    or.push({ campaignId: { $gte: 1 } });
  } else {
    or.push({ campaignId: { $gt: onChainTotal } });
    or.push({ campaignId: { $lt: 1 } });
  }

  return or.length > 0 ? { $or: or } : {};
}

export async function pruneOrphanDonations(onChainTotal?: number): Promise<{
  onChainTotal: number;
  removed: number;
  errors: string[];
}> {
  const total = onChainTotal ?? (await getOnChainTotalCampaigns());
  const result = { onChainTotal: total, removed: 0, errors: [] as string[] };

  try {
    const orphanFilter = orphanDonationFilter(total);
    if (Object.keys(orphanFilter).length === 0) return result;

    const deleted = await Donation.deleteMany(orphanFilter);
    result.removed = deleted.deletedCount ?? 0;
    if (result.removed > 0) {
      console.log(
        `[Reconcile] Pruned ${result.removed} orphan donation(s) outside deployment scope (on-chain total ${total})`
      );
    }
  } catch (err) {
    result.errors.push(String((err as { message?: string })?.message ?? err));
  }

  return result;
}
