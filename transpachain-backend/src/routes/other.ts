import { Router, Request, Response } from "express";
import { Donation } from "../models/Donation";

const donationRouter = Router();
const ipfsRouter = Router();

// =========================================================
// Donations routes
// =========================================================

/**
 * GET /api/donations/:address
 * Get all donations by a donor address (for dashboard).
 */
donationRouter.get("/:address", async (req: Request, res: Response) => {
  try {
    const donations = await Donation.find({
      donorAddress: req.params.address.toLowerCase(),
    })
      .sort({ timestamp: -1 })
      .lean();

    const summary = {
      totalDonated: donations.reduce(
        (acc, d) => acc + BigInt(d.amount),
        0n
      ).toString(),
      count:    donations.length,
      locked:   donations.filter((d) => d.status === "locked").length,
      released: donations.filter((d) => d.status === "released").length,
      refunded: donations.filter((d) => d.status === "refunded").length,
    };

    res.json({ data: donations, summary });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch donations" });
  }
});

// =========================================================
// IPFS routes (via Pinata)
// =========================================================

/**
 * POST /api/ipfs/upload
 * Upload a file or JSON metadata to IPFS via Pinata.
 * Returns the CID (content identifier).
 *
 * Body: FormData with `file` field, or JSON with `metadata` field.
 */
ipfsRouter.post("/upload", async (req: Request, res: Response) => {
  try {
    // TODO: implement Pinata SDK upload
    // const pinata = new PinataSDK(process.env.PINATA_API_KEY, process.env.PINATA_SECRET)
    // const result = await pinata.pinFileToIPFS(req.file.buffer, { pinataMetadata: {...} })
    // res.json({ cid: result.IpfsHash })

    res.status(501).json({ error: "IPFS upload not yet implemented" });
  } catch (err) {
    res.status(500).json({ error: "IPFS upload failed" });
  }
});

/**
 * GET /api/ipfs/:cid
 * Proxy fetch IPFS metadata JSON by CID (avoids CORS in browser).
 */
ipfsRouter.get("/:cid", async (req: Request, res: Response) => {
  try {
    const gatewayUrl = `https://gateway.pinata.cloud/ipfs/${req.params.cid}`;
    const response   = await fetch(gatewayUrl);
    if (!response.ok) return res.status(404).json({ error: "CID not found" });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch from IPFS" });
  }
});

export { donationRouter, ipfsRouter };
