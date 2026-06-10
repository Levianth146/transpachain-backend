import { Router, Request, Response } from "express";
import { Evidence } from "../models/Evidence";

const router = Router();

// GET /evidence?campaignId=&status=
router.get("/", async (req: Request, res: Response) => {
  try {
    const campaignId = req.query.campaignId !== undefined ? Number(req.query.campaignId) : undefined;
    const status = req.query.status as string | undefined;
    const filter: Record<string, unknown> = {};
    if (campaignId !== undefined && !Number.isNaN(campaignId)) filter.campaignId = campaignId;
    if (status) filter.approvalStatus = status;

    const items = await Evidence.find(filter).sort({ submittedAt: -1 }).limit(100).lean();
    res.json({ evidence: items, total: items.length });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /evidence — org submits minh chứng (off-chain; on-chain proofCID separate)
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

    const doc = await Evidence.create({
      campaignId: Number(campaignId),
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
