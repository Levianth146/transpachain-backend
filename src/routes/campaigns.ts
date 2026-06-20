import { Router, Request, Response } from "express";
import { Campaign } from "../models/Campaign";
import { Proposal } from "../models/Proposal";
import { Donation } from "../models/Donation";
import { campaignDisplayTitle } from "../indexer/fetchCampaignMeta";

const router = Router();

function withDataSource<T extends Record<string, unknown>>(doc: T, source: "indexed" = "indexed") {
  return { ...doc, _source: source };
}

function withDisplayTitle<T extends { campaignId: number; title?: string }>(campaign: T) {
  return withDataSource({ ...campaign, title: campaignDisplayTitle(campaign) });
}

// GET /campaigns — list all (paginated, filterable)
router.get("/", async (req: Request, res: Response) => {
  try {
    const page         = Math.max(1, Number(req.query.page)  || 1);
    const limit        = Math.min(100, Number(req.query.limit) || 50);
    const category     = req.query.category as string | undefined;
    const status       = req.query.status !== undefined ? Number(req.query.status) : undefined;
    const filter: Record<string, unknown> = {};
    if (category) filter.category = category;
    if (status !== undefined) filter.status = status;

    const [campaigns, total] = await Promise.all([
      Campaign.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Campaign.countDocuments(filter),
    ]);

    res.json({
      campaigns: campaigns.map(withDisplayTitle),
      total,
      page,
      pages: Math.ceil(total / limit),
      _source: "indexed",
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /campaigns/stats — platform statistics (indexed / MongoDB)
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const [totalCampaigns, activeCampaigns, totalDonations, totalUniqueDonors] = await Promise.all([
      Campaign.countDocuments({}),
      Campaign.countDocuments({ status: 0 }),   // 0 = Active
      Donation.find().lean(),
      Donation.distinct("donor"),
    ]);

    let totalDonatedEth = 0n;
    let totalDonatedUsdc = 0n;
    let totalDonatedGrossEth = 0n;
    let totalDonatedGrossUsdc = 0n;

    for (const d of totalDonations) {
      const gross = BigInt(d.amount || "0");
      const net = BigInt(d.netAmount || d.amount || "0");
      if (d.tokenType === 1) {
        totalDonatedUsdc += net;
        totalDonatedGrossUsdc += gross;
      } else {
        totalDonatedEth += net;
        totalDonatedGrossEth += gross;
      }
    }

    res.json({
      _source: "indexed",
      totalCampaigns,
      activeCampaigns,
      totalDonated: totalDonatedEth.toString(),
      totalDonatedEth: totalDonatedEth.toString(),
      totalDonatedUsdc: totalDonatedUsdc.toString(),
      totalDonatedGrossEth: totalDonatedGrossEth.toString(),
      totalDonatedGrossUsdc: totalDonatedGrossUsdc.toString(),
      countUniqueDonors: totalUniqueDonors.length,
      note: "raisedAmount and totals are net of 1% platform fee; donation.amount is gross sent",
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /campaigns/:id
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const campaign = await Campaign.findOne({ campaignId: Number(req.params.id) }).lean();
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.json(withDisplayTitle(campaign));
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /campaigns/:id/proposals — active governance proposals
router.get("/:id/proposals", async (req: Request, res: Response) => {
  try {
    const proposals = await Proposal.find({
      campaignId: Number(req.params.id),
      $or: [{ approvalStatus: "approved" }, { approvalStatus: { $exists: false } }],
    }).sort({ createdAt: -1 }).lean();
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
