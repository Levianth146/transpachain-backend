import { Router, Request, Response } from "express";
import { Campaign } from "../models/Campaign";
import { Proposal } from "../models/Proposal";
import { Donation } from "../models/Donation";
import { campaignDisplayTitle } from "../indexer/fetchCampaignMeta";
import {
  deploymentCampaignFilter,
  deploymentDonationFilter,
  deploymentProposalFilter,
  getDeployFromBlock,
  getOnChainTotalCampaigns,
} from "../lib/indexedScope";

const router = Router();

/**
 * Data architecture (see also frontend hooks):
 * - Metadata (title, image, description, orgName): Mongo/API — synced from IPFS at index time
 * - Amounts (raised, goal, escrow): always read on-chain in the UI via wagmi getCharityProgress
 * - Donor count: Mongo Donation.distinct("donor") scoped to current deployment (DEPLOY_FROM_BLOCK + on-chain campaign ids)
 * - raisedAmount in Mongo is indexer cache only — never shown directly on campaign cards
 */

function withDataSource<T extends Record<string, unknown>>(doc: T, source: "indexed" = "indexed") {
  return { ...doc, _source: source };
}

function withDisplayTitle<T extends { campaignId: number; title?: string }>(campaign: T) {
  return withDataSource({ ...campaign, title: campaignDisplayTitle(campaign) });
}

/** Keep one row per campaignId (newest updatedAt wins). */
function dedupeCampaignRows<T extends { campaignId: number; updatedAt?: Date }>(rows: T[]): T[] {
  const byId = new Map<number, T>();
  for (const row of rows) {
    const id = Number(row.campaignId);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, row);
      continue;
    }
    const existingTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
    const rowTime = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
    if (rowTime >= existingTime) byId.set(id, row);
  }
  return Array.from(byId.values()).sort((a, b) => {
    const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bTime - aTime;
  });
}

// GET /campaigns — list all (paginated, filterable, scoped to current deployment)
router.get("/", async (req: Request, res: Response) => {
  try {
    const onChainTotal = await getOnChainTotalCampaigns();
    const page         = Math.max(1, Number(req.query.page)  || 1);
    const limit        = Math.min(100, Number(req.query.limit) || 50);
    const category     = req.query.category as string | undefined;
    const status       = req.query.status !== undefined ? Number(req.query.status) : undefined;
    const filter: Record<string, unknown> = { ...deploymentCampaignFilter(onChainTotal) };
    if (category) filter.category = category;
    if (status !== undefined) filter.status = status;

    const [rawCampaigns] = await Promise.all([
      Campaign.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);

    const campaigns = dedupeCampaignRows(rawCampaigns);
    const distinctIds = await Campaign.distinct("campaignId", filter);
    const total = distinctIds.length;

    res.json({
      campaigns: campaigns.map(withDisplayTitle),
      total,
      page,
      pages: Math.ceil(total / limit),
      _source: "indexed",
      onChainTotalCampaigns: onChainTotal,
      _deduped: campaigns.length < rawCampaigns.length,
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /campaigns/stats — platform statistics (indexed / MongoDB, scoped to current deployment)
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const onChainTotal = await getOnChainTotalCampaigns();
    const donationScope = deploymentDonationFilter(onChainTotal);
    const campaignScope =
      onChainTotal <= 0
        ? { campaignId: { $in: [] as number[] } }
        : { campaignId: { $gte: 1, $lte: onChainTotal } };

    const [activeCampaigns, totalDonations, donorAgg] = await Promise.all([
      Campaign.countDocuments({ ...campaignScope, status: 0 }), // 0 = Active
      Donation.find(donationScope).lean(),
      Donation.aggregate<{ _id: string }>([
        { $match: { ...donationScope, donor: { $exists: true, $nin: [null, ""] } } },
        { $group: { _id: { $toLower: "$donor" } } },
      ]),
    ]);
    const totalCampaigns = onChainTotal;
    const countUniqueDonors = donorAgg.length;

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
      countUniqueDonors,
      deployFromBlock: getDeployFromBlock(),
      note: "Campaign and donor counts scoped to current CharityCore (on-chain totalCampaigns + DEPLOY_FROM_BLOCK). Raised totals are on-chain in UI.",
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /campaigns/:id
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const campaignId = Number(req.params.id);
    const onChainTotal = await getOnChainTotalCampaigns();
    if (onChainTotal <= 0 || campaignId < 1 || campaignId > onChainTotal) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    const campaign = await Campaign.findOne({ campaignId }).lean();
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.json(withDisplayTitle(campaign));
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /campaigns/:id/proposals — active governance proposals
router.get("/:id/proposals", async (req: Request, res: Response) => {
  try {
    const campaignId = Number(req.params.id);
    const onChainTotal = await getOnChainTotalCampaigns();
    if (onChainTotal <= 0 || campaignId < 1 || campaignId > onChainTotal) {
      return res.json([]);
    }
    const proposals = await Proposal.find({
      ...deploymentProposalFilter(onChainTotal),
      campaignId,
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
    const onChainTotal = await getOnChainTotalCampaigns();
    const donationScope = deploymentDonationFilter(onChainTotal);
    const donations = await Donation.find({
      ...donationScope,
      campaignId: Number(req.params.id),
    }).sort({ timestamp: -1 }).lean();
    res.json(donations);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
