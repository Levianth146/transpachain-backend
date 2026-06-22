import { Router, Request, Response } from "express";
import { Evidence } from "../models/Evidence";
import { deploymentEvidenceFilter, getOnChainTotalCampaigns } from "../lib/indexedScope";

const router = Router();

// GET /evidence?campaignId=&status=
router.get("/", async (req: Request, res: Response) => {
  try {
    const onChainTotal = await getOnChainTotalCampaigns();
    const campaignId = req.query.campaignId !== undefined ? Number(req.query.campaignId) : undefined;
    const status = req.query.status as string | undefined;
    const filter: Record<string, unknown> = { ...deploymentEvidenceFilter(onChainTotal) };
    if (campaignId !== undefined && !Number.isNaN(campaignId)) {
      if (onChainTotal <= 0 || campaignId < 1 || campaignId > onChainTotal) {
        return res.json({ evidence: [], total: 0 });
      }
      filter.campaignId = campaignId;
    }
    if (status) filter.approvalStatus = status;

    const items = await Evidence.find(filter).sort({ submittedAt: -1 }).limit(100).lean();
    res.json({ evidence: items, total: items.length });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /evidence — org submits milestone evidence (off-chain; on-chain proofCID is separate)
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      campaignId,
      milestoneIndex,
      orgAddress,
      title,
      description,
      imageUrl,
      ipfsCID,
    } = req.body as Record<string, unknown>;

    if (!campaignId || orgAddress === undefined || milestoneIndex === undefined) {
      return res.status(400).json({ error: "campaignId, milestoneIndex, orgAddress required" });
    }

    const id = Number(campaignId);
    const onChainTotal = await getOnChainTotalCampaigns();
    if (onChainTotal <= 0 || id < 1 || id > onChainTotal) {
      return res.status(400).json({ error: "Campaign not found on current deployment" });
    }

    const doc = await Evidence.create({
      campaignId: id,
      milestoneIndex: Number(milestoneIndex),
      orgAddress: String(orgAddress).toLowerCase(),
      title: String(title ?? ""),
      description: String(description ?? ""),
      imageUrl: String(imageUrl ?? ""),
      ipfsCID: String(ipfsCID ?? ""),
      approvalStatus: "pending",
    });

    res.status(201).json(doc);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
