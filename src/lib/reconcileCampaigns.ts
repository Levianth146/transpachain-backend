import { ethers } from "ethers";
import { Campaign } from "../models/Campaign";
import { withRpcFallback } from "./rpcProvider";

const CHARITY_CORE_ABI = [
  "function getCampaign(uint256) view returns (tuple(uint256,address,string,uint256,uint256,uint256,uint8,uint8,uint8,uint8,string,uint256,uint256))",
];

export interface ReconcileResult {
  checked: number;
  updated: number;
  errors: string[];
}

/** Sync Mongo raisedAmount from on-chain CharityCore (net after fee). */
export async function reconcileCampaignRaisedAmounts(): Promise<ReconcileResult> {
  const address = process.env.CHARITY_CORE_ADDRESS;
  if (!address) {
    return { checked: 0, updated: 0, errors: ["CHARITY_CORE_ADDRESS not set"] };
  }

  const campaigns = await Campaign.find({}).select("campaignId raisedAmount").lean();
  const result: ReconcileResult = { checked: campaigns.length, updated: 0, errors: [] };

  await withRpcFallback("reconcileCampaigns", async (provider) => {
    const core = new ethers.Contract(address, CHARITY_CORE_ABI, provider);

    for (const camp of campaigns) {
      try {
        const onChain = await core.getCampaign(camp.campaignId);
        const onChainRaised = onChain[4].toString();
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
  });

  return result;
}
