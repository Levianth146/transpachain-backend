import { Router, Request, Response } from "express";
import { VerifiedOrg } from "../models/VerifiedOrg";
import { OrgProfile } from "../models/OrgProfile";
import { Proposal } from "../models/Proposal";
import { Evidence } from "../models/Evidence";
import { reconcileCampaignRaisedAmounts } from "../lib/reconcileCampaigns";

const router = Router();

// GET /admin/verified-orgs — list all currently verified organizations
router.get("/verified-orgs", async (_req: Request, res: Response) => {
  try {
    const orgs = await VerifiedOrg.find({ verified: true })
      .sort({ updatedAt: -1 })
      .lean();

    res.json({
      orgs: orgs.map((o) => ({
        address:     o.address,
        updatedAt:   o.updatedAt,
        blockNumber: o.blockNumber,
        txHash:      o.txHash,
      })),
      total: orgs.length,
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/org-profiles — pending KYC-style applications
router.get("/org-profiles", async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || "pending";
    const profiles = await OrgProfile.find({ status }).sort({ submittedAt: -1 }).lean();
    res.json({ profiles, total: profiles.length });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /admin/org-profiles/:address — verifier marks approved/rejected (on-chain verify is separate)
router.patch("/org-profiles/:address", async (req: Request, res: Response) => {
  try {
    const orgAddress = String(req.params.address).toLowerCase();
    const { status, reviewerNote } = req.body as { status?: string; reviewerNote?: string };
    if (!["approved", "rejected", "pending"].includes(status ?? "")) {
      return res.status(400).json({ error: "status must be approved, rejected, or pending" });
    }
    const profile = await OrgProfile.findOneAndUpdate(
      { orgAddress },
      { status, reviewerNote: reviewerNote ?? "", reviewedAt: new Date() },
      { new: true }
    );
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    res.json(profile);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/proposals?approval=pending
router.get("/proposals", async (req: Request, res: Response) => {
  try {
    const approval = (req.query.approval as string) || "pending";
    const proposals = await Proposal.find({ approvalStatus: approval })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ proposals, total: proposals.length });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /admin/proposals/:proposalId — approve/reject or close with reason
router.patch("/proposals/:proposalId", async (req: Request, res: Response) => {
  try {
    const proposalId = Number(req.params.proposalId);
    const { approvalStatus, closedByAdmin, closedReason } = req.body as {
      approvalStatus?: string;
      closedByAdmin?: boolean;
      closedReason?: string;
    };

    if (closedByAdmin) {
      const proposal = await Proposal.findOneAndUpdate(
        { proposalId },
        {
          closedByAdmin: true,
          closedReason: closedReason ?? "Closed by admin",
          closedAt: new Date(),
          state: 5,
          approvalStatus: "rejected",
        },
        { new: true }
      );
      if (!proposal) return res.status(404).json({ error: "Proposal not found" });
      return res.json(proposal);
    }

    if (!["approved", "rejected", "pending"].includes(approvalStatus ?? "")) {
      return res.status(400).json({ error: "approvalStatus must be approved, rejected, or pending" });
    }
    const proposal = await Proposal.findOneAndUpdate(
      { proposalId },
      { approvalStatus },
      { new: true }
    );
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    res.json(proposal);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /admin/evidence/:id
router.patch("/evidence/:id", async (req: Request, res: Response) => {
  try {
    const { approvalStatus, reviewerNote } = req.body as {
      approvalStatus?: string;
      reviewerNote?: string;
    };
    if (!["approved", "rejected", "pending"].includes(approvalStatus ?? "")) {
      return res.status(400).json({ error: "invalid approvalStatus" });
    }
    const item = await Evidence.findByIdAndUpdate(
      req.params.id,
      { approvalStatus, reviewerNote: reviewerNote ?? "", reviewedAt: new Date() },
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Evidence not found" });
    res.json(item);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/evidence?approval=pending
router.get("/evidence", async (req: Request, res: Response) => {
  try {
    const approval = (req.query.approval as string) || "pending";
    const items = await Evidence.find({ approvalStatus: approval }).sort({ submittedAt: -1 }).lean();
    res.json({ evidence: items, total: items.length });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/reconcile-campaigns — sync Mongo raisedAmount from on-chain CharityCore
router.post("/reconcile-campaigns", async (_req: Request, res: Response) => {
  try {
    const result = await reconcileCampaignRaisedAmounts();
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: "Reconcile failed",
      detail: String((err as { message?: string })?.message ?? err),
    });
  }
});

export default router;