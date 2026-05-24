import { Router, Request, Response } from "express";
import PinataSDK from "@pinata/sdk";
import multer from "multer";
import { Readable } from "stream";

const router = Router();

// ─── Init Pinata ──────────────────────────────────────────────
const getPinata = () => new PinataSDK(process.env.PINATA_API_KEY!, process.env.PINATA_SECRET_KEY!);

// ─── Multer — store file in memory (not disk) ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // max 10MB
});

// POST /ipfs/metadata — pin JSON metadata
// Body: { title, description, category, imageUrl, orgName, goalAmount }
router.post("/metadata", async (req: Request, res: Response) => {
  try {
    const { title, description, category, imageUrl, orgName, goalAmount } = req.body;
    if (!title || !description || !category || !imageUrl || !orgName || !goalAmount ) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const result = await getPinata().pinJSONToIPFS(req.body, {
      pinataMetadata: { name: req.body.title || "campaign-metadata" }
    });
    res.json({ cid: result.IpfsHash });
  } catch (err) {
    console.error("[IPFS] metadata error:", err);
    res.status(500).json({ error: "Failed to pin metadata" });
  }
});

// POST /ipfs/upload — upload file/metadata to Pinata
// FormData: file field
router.post("/upload", upload.single("file") ,async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const stream = Readable.from(req.file!.buffer);
    const result = await getPinata().pinFileToIPFS(stream, {
      pinataMetadata: { name: req.file!.originalname }
    });
    const cid = result.IpfsHash;
    res.json({ cid, url: `https://gateway.pinata.cloud/ipfs/${cid}` });
  } catch (err) {
    res.status(500).json({ error: "Failed to upload file" });
  }
});

// GET /ipfs/:cid — proxy fetch IPFS metadata (avoids CORS in browser)
router.get("/:cid", async (req: Request, res: Response) => {
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

export default router;
