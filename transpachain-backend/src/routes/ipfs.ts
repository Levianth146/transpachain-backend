import { Router, Request, Response } from "express";
// import PinataSDK from "@pinata/sdk";

const router = Router();
// const pinata = new PinataSDK(process.env.PINATA_API_KEY!, process.env.PINATA_SECRET_KEY!);

// POST /ipfs/upload — upload file/metadata to Pinata
router.post("/upload", async (req: Request, res: Response) => {
  // TODO Phase 3: handle multipart form data, upload to Pinata, return CID
  res.status(501).json({ error: "Not implemented — TODO Phase 3" });
});

// POST /ipfs/metadata — pin JSON metadata
router.post("/metadata", async (req: Request, res: Response) => {
  // TODO Phase 3: pinata.pinJSONToIPFS(req.body)
  res.status(501).json({ error: "Not implemented — TODO Phase 3" });
});

export default router;
