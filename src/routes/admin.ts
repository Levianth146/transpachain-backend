import { Router, Request, Response } from "express";
import { VerifiedOrg } from "../models/VerifiedOrg";
import { OrgProfile } from "../models/OrgProfile";

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

export default router;