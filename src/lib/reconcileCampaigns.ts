import { ethers } from "ethers";
import { Campaign } from "../models/Campaign";
import { fetchCampaignMeta } from "../indexer/fetchCampaignMeta";
import { pruneOrphanDonations, pruneOrphanEvidence, pruneOrphanProposals, pruneOrphanVerifiedOrgs } from "./indexedScope";
import { withRpcFallback } from "./rpcProvider";

const CHARITY_CORE_ABI = [
  "function getCampaign(uint256) view returns (tuple(uint256,address,string,uint256,uint256,uint256,uint8,uint8,uint8,uint8,string,uint256,uint256))",
  "function totalCampaigns() view returns (uint256)",
];

export interface ReconcileResult {
  checked: number;
  updated: number;
  errors: string[];
}

export interface SyncMissingResult {
  onChainTotal: number;
  checked: number;
  created: number;
  errors: string[];
}

export interface DedupeResult {
  duplicateGroups: number;
  removed: number;
  errors: string[];
}

export interface PruneResult {
  onChainTotal: number;
  removed: number;
  errors: string[];
}

export interface FullReconcileResult {
  missing: SyncMissingResult;
  raised: ReconcileResult;
  dedupe: DedupeResult;
  prune: PruneResult;
  donations: { onChainTotal: number; removed: number; errors: string[] };
  proposals: { onChainTotal: number; removed: number; errors: string[] };
  evidence: { onChainTotal: number; removed: number; errors: string[] };
  verifiedOrgs: { removed: number; errors: string[] };
}

/** Remove duplicate Mongo rows sharing the same campaignId (keep newest updatedAt). */
export async function dedupeDuplicateCampaigns(): Promise<DedupeResult> {
  const result: DedupeResult = { duplicateGroups: 0, removed: 0, errors: [] };

  try {
    const groups = await Campaign.aggregate<{
      _id: number;
      count: number;
      docs: Array<{ _id: unknown; updatedAt: Date }>;
    }>([
      { $sort: { updatedAt: -1 } },
      { $group: { _id: "$campaignId", count: { $sum: 1 }, docs: { $push: { _id: "$_id", updatedAt: "$updatedAt" } } } },
      { $match: { count: { $gt: 1 } } },
    ]);

    result.duplicateGroups = groups.length;

    for (const group of groups) {
      const [, ...stale] = group.docs;
      const staleIds = stale.map((d) => d._id);
      if (staleIds.length === 0) continue;
      const deleted = await Campaign.deleteMany({ _id: { $in: staleIds } });
      result.removed += deleted.deletedCount ?? 0;
      console.log(`[Reconcile] Removed ${deleted.deletedCount} duplicate(s) for campaignId ${group._id}`);
    }
  } catch (err) {
    result.errors.push(String((err as { message?: string })?.message ?? err));
  }

  return result;
}

/** Delete indexed campaigns whose id exceeds on-chain totalCampaigns(). */
export async function pruneOrphanCampaigns(): Promise<PruneResult> {
  const address = process.env.CHARITY_CORE_ADDRESS;
  if (!address) {
    return { onChainTotal: 0, removed: 0, errors: ["CHARITY_CORE_ADDRESS not set"] };
  }

  const onChainTotal = await withRpcFallback("prune-totalCampaigns", async (provider) => {
    const core = new ethers.Contract(address, CHARITY_CORE_ABI, provider);
    return Number(await core.totalCampaigns());
  });

  const result: PruneResult = { onChainTotal, removed: 0, errors: [] };

  try {
    const deleted = await Campaign.deleteMany({ campaignId: { $gt: onChainTotal } });
    result.removed = deleted.deletedCount ?? 0;
    if (result.removed > 0) {
      console.log(`[Reconcile] Pruned ${result.removed} orphan campaign(s) above on-chain total ${onChainTotal}`);
    }
  } catch (err) {
    result.errors.push(String((err as { message?: string })?.message ?? err));
  }

  return result;
}

/** Upsert campaigns that exist on-chain (ids 1..totalCampaigns) but are missing in Mongo. */
export async function syncMissingCampaigns(): Promise<SyncMissingResult> {
  const address = process.env.CHARITY_CORE_ADDRESS;
  if (!address) {
    return { onChainTotal: 0, checked: 0, created: 0, errors: ["CHARITY_CORE_ADDRESS not set"] };
  }

  const totalCampaigns = await withRpcFallback("sync-totalCampaigns", async (provider) => {
    const core = new ethers.Contract(address, CHARITY_CORE_ABI, provider);
    return Number(await core.totalCampaigns());
  });

  const existingIds = new Set(
    (await Campaign.find({}).select("campaignId").lean()).map((c) => c.campaignId)
  );

  const result: SyncMissingResult = {
    onChainTotal: totalCampaigns,
    checked: totalCampaigns,
    created: 0,
    errors: [],
  };

  for (let id = 1; id <= totalCampaigns; id++) {
    if (existingIds.has(id)) continue;
    try {
      await withRpcFallback(`sync-missing-campaign-${id}`, async (provider) => {
        const core = new ethers.Contract(address, CHARITY_CORE_ABI, provider);
        const campaignData = await core.getCampaign(id);
        const metadataCID = campaignData[2];
        const meta = await fetchCampaignMeta(metadataCID, id);

        await Campaign.findOneAndUpdate(
          { campaignId: id },
          {
            campaignId: id,
            orgAddress: String(campaignData[1]).toLowerCase(),
            metadataCID,
            ...meta,
            goalAmount: campaignData[3].toString(),
            raisedAmount: campaignData[4].toString(),
            deadline: Number(campaignData[5]),
            status: Number(campaignData[6]),
            totalMilestones: Number(campaignData[7]),
            completedMilestones: Number(campaignData[8]),
            paymentToken: Number(campaignData[9]),
            cancelledAt: Number(campaignData[12]),
          },
          { upsert: true }
        );
      });
      result.created++;
      console.log(`[Reconcile] Synced missing campaign #${id}`);
    } catch (err) {
      result.errors.push(
        `campaign ${id}: ${String((err as { message?: string })?.message ?? err)}`
      );
    }
  }

  return result;
}

/** Sync Mongo raisedAmount from on-chain CharityCore (net after fee). */
export async function reconcileCampaignRaisedAmounts(): Promise<ReconcileResult> {
  const address = process.env.CHARITY_CORE_ADDRESS;
  if (!address) {
    return { checked: 0, updated: 0, errors: ["CHARITY_CORE_ADDRESS not set"] };
  }

  const campaigns = await Campaign.find({}).select("campaignId raisedAmount").lean();
  const result: ReconcileResult = { checked: campaigns.length, updated: 0, errors: [] };

  for (const camp of campaigns) {
    try {
      const onChainRaised = await withRpcFallback(
        `reconcile-campaign-${camp.campaignId}`,
        async (provider) => {
          const core = new ethers.Contract(address, CHARITY_CORE_ABI, provider);
          const onChain = await core.getCampaign(camp.campaignId);
          return onChain[4].toString();
        }
      );
      if (onChainRaised !== (camp.raisedAmount || "0")) {
        await Campaign.findOneAndUpdate(
          { campaignId: camp.campaignId },
          { raisedAmount: onChainRaised }
        );
        result.updated++;
      }
    } catch (err) {
      result.errors.push(
        `campaign ${camp.campaignId}: ${String((err as { message?: string })?.message ?? err)}`
      );
    }
  }

  return result;
}

/** Sync missing campaigns from chain, dedupe/prune Mongo, then reconcile raised amounts. */
export async function reconcileCampaigns(): Promise<FullReconcileResult> {
  const dedupe = await dedupeDuplicateCampaigns();
  const prune = await pruneOrphanCampaigns();
  const donations = await pruneOrphanDonations(prune.onChainTotal);
  const proposals = await pruneOrphanProposals(prune.onChainTotal);
  const evidence = await pruneOrphanEvidence(prune.onChainTotal);
  const verifiedOrgs = await pruneOrphanVerifiedOrgs();
  const missing = await syncMissingCampaigns();
  const raised = await reconcileCampaignRaisedAmounts();
  return { missing, raised, dedupe, prune, donations, proposals, evidence, verifiedOrgs };
}
