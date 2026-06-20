import { ethers } from "ethers";
import { Campaign } from "../models/Campaign";
import { fetchCampaignMeta } from "../indexer/fetchCampaignMeta";
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

export interface FullReconcileResult {
  missing: SyncMissingResult;
  raised: ReconcileResult;
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

/** Sync missing campaigns from chain, then reconcile raised amounts for all indexed campaigns. */
export async function reconcileCampaigns(): Promise<FullReconcileResult> {
  const missing = await syncMissingCampaigns();
  const raised = await reconcileCampaignRaisedAmounts();
  return { missing, raised };
}
