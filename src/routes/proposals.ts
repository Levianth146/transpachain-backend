import { Router, Request, Response } from "express";
import { Proposal } from "../models/Proposal";
import { Campaign } from "../models/Campaign";
import {
  deploymentCampaignFilter,
  deploymentProposalFilter,
  getOnChainTotalCampaigns,
} from "../lib/indexedScope";

const router = Router();

const STATE_LABEL: Record<number, string> = {
  0: "Pending",
  1: "Active",
  2: "Defeated",
  3: "Queued",
  4: "Executed",
  5: "Cancelled",
};

// GET /proposals — DAO hub: all proposals with campaign title (scoped to current deployment)
router.get("/", async (req: Request, res: Response) => {
  try {
    const onChainTotal = await getOnChainTotalCampaigns();
    const scope = deploymentProposalFilter(onChainTotal);
    const state = req.query.state !== undefined ? Number(req.query.state) : undefined;
    const approval = (req.query.approval as string) || "approved";
    const filter: Record<string, unknown> = { ...scope };
    if (state !== undefined && !Number.isNaN(state)) filter.state = state;
    if (approval === "approved") {
      filter.$or = [{ approvalStatus: "approved" }, { approvalStatus: { $exists: false } }];
    } else if (approval !== "all") {
      filter.approvalStatus = approval;
    }

    const proposals = await Proposal.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    const campaignIds = [...new Set(proposals.map((p) => p.campaignId))];
    const campaigns = await Campaign.find({
      ...deploymentCampaignFilter(onChainTotal),
      campaignId: { $in: campaignIds },
    }).lean();
    const byId = Object.fromEntries(campaigns.map((c) => [c.campaignId, c]));

    const enriched = proposals
      .filter((p) => !p.closedByAdmin)
      .map((p) => ({
        ...p,
        stateLabel: STATE_LABEL[p.state] ?? "Unknown",
        campaignTitle: byId[p.campaignId]?.title ?? `Campaign #${p.campaignId}`,
        campaignCategory: byId[p.campaignId]?.category ?? "",
      }));

    res.json({ proposals: enriched, total: enriched.length, _source: "indexed", onChainTotalCampaigns: onChainTotal });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
