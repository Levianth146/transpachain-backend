import { Router, Request, Response } from "express";
import { OrgProfile } from "../models/OrgProfile";

const router = Router();

// GET /orgs — list by status (for admin/verifier UI)
router.get("/", async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || "pending";
    const profiles = await OrgProfile.find({ status }).sort({ submittedAt: -1 }).lean();
    res.json({ profiles, total: profiles.length });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /orgs/:address — public org profile (off-chain KYC-style metadata)
router.get("/:address", async (req: Request, res: Response) => {
  try {
    const orgAddress = String(req.params.address).toLowerCase();
    const profile = await OrgProfile.findOne({ orgAddress }).lean();
    if (!profile) return res.status(404).json({ error: "Org profile not found" });
    res.json(profile);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /orgs — org submits or updates profile (wallet address in body)
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      orgAddress,
      legalName,
      description,
      website,
      country,
      registrationDocCID,
      contactEmail,
    } = req.body as Record<string, string>;

    if (!orgAddress) return res.status(400).json({ error: "orgAddress required" });

    const profile = await OrgProfile.findOneAndUpdate(
      { orgAddress: orgAddress.toLowerCase() },
      {
        orgAddress: orgAddress.toLowerCase(),
        legalName: legalName ?? "",
        description: description ?? "",
        website: website ?? "",
        country: country ?? "",
        registrationDocCID: registrationDocCID ?? "",
        contactEmail: contactEmail ?? "",
        status: "pending",
        submittedAt: new Date(),
      },
      { upsert: true, new: true }
    );
    res.json(profile);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
