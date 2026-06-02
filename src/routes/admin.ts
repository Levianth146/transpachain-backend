import { Router, Request, Response } from "express";
import { VerifiedOrg } from "../models/VerifiedOrg";

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

export default router;