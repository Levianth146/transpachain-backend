import { Router, Request, Response } from "express";
import { Donation } from "../models/Donation";
import { deploymentDonationFilter, getOnChainTotalCampaigns } from "../lib/indexedScope";

const router = Router();

async function scopedDonationFilter() {
  const onChainTotal = await getOnChainTotalCampaigns();
  return deploymentDonationFilter(onChainTotal);
}

// GET /donations/campaign/:id — all donations to a campaign
router.get("/campaign/:id", async (req: Request, res: Response) => {
  try {
    const scope = await scopedDonationFilter();
    const donations = await Donation.find({
      ...scope,
      campaignId: Number(req.params.id),
    })
      .sort({ timestamp: -1 }).lean();
    res.json({ donations });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /donations/summary/:address - summarize donations from a single donor
router.get("/summary/:address", async (req: Request, res: Response) => {
  try {
    const scope = await scopedDonationFilter();
    const donations = await Donation.find({
      ...scope,
      donor: req.params.address.toLowerCase(),
    }).lean();

    const totalDonated = donations.reduce((acc, d) => acc + BigInt(d.amount), 0n).toString();
    const campaignCount = new Set(donations.map(d => d.campaignId)).size;
    const byStatus = {
      locked: donations.filter(d => d.status === "locked").length,
      released: donations.filter(d => d.status === "released").length,
      refunded: donations.filter(d => d.status === "refunded").length,
    };
    res.json({ totalDonated, campaignCount, byStatus, donations });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
})

// GET /donations/:address — all donations by a wallet
router.get("/:address", async (req: Request, res: Response) => {
  try {
    const scope = await scopedDonationFilter();
    const donations = await Donation.find({
      ...scope,
      donor: req.params.address.toLowerCase(),
    }).sort({ timestamp: -1 }).lean();
    res.json({ donations });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
