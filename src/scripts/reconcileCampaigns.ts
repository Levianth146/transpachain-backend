import dotenv from "dotenv";
import mongoose from "mongoose";
import { reconcileCampaigns } from "../lib/reconcileCampaigns";

dotenv.config();

async function main() {
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/transpachain";
  await mongoose.connect(mongoUri);
  console.log("[Reconcile] Connected to MongoDB");

  const result = await reconcileCampaigns();
  console.log("[Reconcile] Missing campaigns:", result.missing);
  console.log("[Reconcile] Raised amounts:", result.raised);

  const hasErrors = result.missing.errors.length > 0 || result.raised.errors.length > 0;
  await mongoose.disconnect();
  process.exit(hasErrors ? 1 : 0);
}

main().catch((err) => {
  console.error("[Reconcile] Failed:", err);
  process.exit(1);
});
