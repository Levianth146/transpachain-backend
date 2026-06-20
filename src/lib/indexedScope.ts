import { FilterQuery } from "mongoose";
import { ethers } from "ethers";
import { Donation, IDonation } from "../models/Donation";
import { IProposal } from "../models/Proposal";
import { IEvidence } from "../models/Evidence";
import { ICampaign } from "../models/Campaign";
import { IVerifiedOrg } from "../models/VerifiedOrg";
import { Proposal } from "../models/Proposal";
import { Evidence } from "../models/Evidence";
import { VerifiedOrg } from "../models/VerifiedOrg";
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

/** Campaign ids valid for the current on-chain deployment (empty when total is 0). */
export function deploymentCampaignIdFilter(onChainTotal: number): FilterQuery<{ campaignId: number }> {
  if (onChainTotal <= 0) {
    return { campaignId: { $in: [] as number[] } };
  }
  return { campaignId: { $gte: 1, $lte: onChainTotal } };
}

export function deploymentCampaignFilter(onChainTotal: number): FilterQuery<ICampaign> {
  return deploymentCampaignIdFilter(onChainTotal);
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

  Object.assign(filter, deploymentCampaignIdFilter(onChainTotal));
  return filter;
}

/**
 * Proposals indexed from GovernanceDAO — scoped by campaign id and blockNumber when set.
 * Rows without blockNumber are excluded when DEPLOY_FROM_BLOCK > 0 (legacy pre-redeploy data).
 */
export function deploymentProposalFilter(onChainTotal: number): FilterQuery<IProposal> {
  const filter: FilterQuery<IProposal> = {};
  const deployBlock = getDeployFromBlock();

  if (deployBlock > 0) {
    filter.blockNumber = { $gte: deployBlock };
  }

  Object.assign(filter, deploymentCampaignIdFilter(onChainTotal));
  return filter;
}

/** Off-chain evidence tied to campaigns — scoped by campaign id only. */
export function deploymentEvidenceFilter(onChainTotal: number): FilterQuery<IEvidence> {
  return deploymentCampaignIdFilter(onChainTotal);
}

/** Verified org events from current CharityCore deployment. */
export function deploymentVerifiedOrgFilter(): FilterQuery<IVerifiedOrg> {
  const deployBlock = getDeployFromBlock();
  if (deployBlock <= 0) return {};
  return { blockNumber: { $gte: deployBlock } };
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

export function orphanProposalFilter(onChainTotal: number): FilterQuery<IProposal> {
  const deployBlock = getDeployFromBlock();
  const or: FilterQuery<IProposal>[] = [];

  if (deployBlock > 0) {
    or.push({ blockNumber: { $lt: deployBlock } });
    or.push({ blockNumber: { $exists: false } });
  }

  if (onChainTotal <= 0) {
    or.push({ campaignId: { $gte: 1 } });
  } else {
    or.push({ campaignId: { $gt: onChainTotal } });
    or.push({ campaignId: { $lt: 1 } });
  }

  return or.length > 0 ? { $or: or } : {};
}

export function orphanEvidenceFilter(onChainTotal: number): FilterQuery<IEvidence> {
  if (onChainTotal <= 0) {
    return { campaignId: { $gte: 1 } };
  }
  return {
    $or: [{ campaignId: { $gt: onChainTotal } }, { campaignId: { $lt: 1 } }],
  };
}

export function orphanVerifiedOrgFilter(): FilterQuery<IVerifiedOrg> {
  const deployBlock = getDeployFromBlock();
  if (deployBlock <= 0) return {};
  return {
    $or: [{ blockNumber: { $lt: deployBlock } }, { blockNumber: { $exists: false } }],
  };
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

export async function pruneOrphanProposals(onChainTotal?: number): Promise<{
  onChainTotal: number;
  removed: number;
  errors: string[];
}> {
  const total = onChainTotal ?? (await getOnChainTotalCampaigns());
  const result = { onChainTotal: total, removed: 0, errors: [] as string[] };

  try {
    const orphanFilter = orphanProposalFilter(total);
    if (Object.keys(orphanFilter).length === 0) return result;

    const deleted = await Proposal.deleteMany(orphanFilter);
    result.removed = deleted.deletedCount ?? 0;
    if (result.removed > 0) {
      console.log(
        `[Reconcile] Pruned ${result.removed} orphan proposal(s) outside deployment scope (on-chain total ${total})`
      );
    }
  } catch (err) {
    result.errors.push(String((err as { message?: string })?.message ?? err));
  }

  return result;
}

export async function pruneOrphanEvidence(onChainTotal?: number): Promise<{
  onChainTotal: number;
  removed: number;
  errors: string[];
}> {
  const total = onChainTotal ?? (await getOnChainTotalCampaigns());
  const result = { onChainTotal: total, removed: 0, errors: [] as string[] };

  try {
    const orphanFilter = orphanEvidenceFilter(total);
    if (Object.keys(orphanFilter).length === 0) return result;

    const deleted = await Evidence.deleteMany(orphanFilter);
    result.removed = deleted.deletedCount ?? 0;
    if (result.removed > 0) {
      console.log(
        `[Reconcile] Pruned ${result.removed} orphan evidence row(s) outside deployment scope (on-chain total ${total})`
      );
    }
  } catch (err) {
    result.errors.push(String((err as { message?: string })?.message ?? err));
  }

  return result;
}

export async function pruneOrphanVerifiedOrgs(): Promise<{
  removed: number;
  errors: string[];
}> {
  const result = { removed: 0, errors: [] as string[] };

  try {
    const orphanFilter = orphanVerifiedOrgFilter();
    if (Object.keys(orphanFilter).length === 0) return result;

    const deleted = await VerifiedOrg.deleteMany(orphanFilter);
    result.removed = deleted.deletedCount ?? 0;
    if (result.removed > 0) {
      console.log(`[Reconcile] Pruned ${result.removed} verified org row(s) from prior deployment`);
    }
  } catch (err) {
    result.errors.push(String((err as { message?: string })?.message ?? err));
  }

  return result;
}
