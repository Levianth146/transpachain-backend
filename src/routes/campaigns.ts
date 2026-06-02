import { Router, Request, Response } from "express";
import { Campaign } from "../models/Campaign";
import { Proposal } from "../models/Proposal";
import { Donation } from "../models/Donation";

const router = Router();

// GET /campaigns — list all (paginated, filterable)
router.get("/", async (req: Request, res: Response) => {
  try {
    const page     = Math.max(1, Number(req.query.page)  || 1);
    const limit    = Math.min(50, Number(req.query.limit) || 12);
    const category = req.query.category as string | undefined;
    const status   = req.query.status !== undefined ? Number(req.query.status) : undefined;

    const filter: Record<string, unknown> = {};
    if (category) filter.category = category;
    if (status !== undefined) filter.status = status;

    const [campaigns, total] = await Promise.all([
      Campaign.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Campaign.countDocuments(filter),
    ]);

    res.json({ campaigns, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /campaigns/stats — platform statistics
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const [totalCampaigns, activeCampaigns, totalDonations, totalUniqueDonors] = await Promise.all([
      Campaign.countDocuments({ title: { $exists: true, $ne: "" } }),
      Campaign.countDocuments({ status: 0, title: { $exists: true, $ne: "" } }),   // 0 = Active
      Donation.find().lean(),
      Donation.distinct("donor"),
    ]);
    const totalDonated = totalDonations.reduce((acc, d) => acc + BigInt(d.amount), 0n ).toString();
    const countUniqueDonors = totalUniqueDonors.length;
    res.json({ totalCampaigns, activeCampaigns, totalDonated, countUniqueDonors })
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /campaigns/:id
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const campaign = await Campaign.findOne({ campaignId: Number(req.params.id) }).lean();
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.json(campaign);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /campaigns/:id/proposals — active governance proposals
router.get("/:id/proposals", async (req: Request, res: Response) => {
  try {
    const proposals = await Proposal.find({ campaignId: Number(req.params.id) }).sort({ createdAt: -1 }).lean();
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /campaigns/:id/donations — list all donations
router.get("/:id/donations", async (req: Request, res: Response) => {
  try {
    const donations = await Donation.find({ campaignId: Number(req.params.id) }).sort({ timestamp: -1 }).lean();
    res.json(donations);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
