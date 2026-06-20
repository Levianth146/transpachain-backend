import dotenv from "dotenv";
import mongoose from "mongoose";
import { reconcileCampaignRaisedAmounts } from "../lib/reconcileCampaigns";

dotenv.config();

async function main() {
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/transpachain";
  await mongoose.connect(mongoUri);
  console.log("[Reconcile] Connected to MongoDB");

  const result = await reconcileCampaignRaisedAmounts();
  console.log("[Reconcile] Done:", result);

  await mongoose.disconnect();
  process.exit(result.errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[Reconcile] Failed:", err);
  process.exit(1);
});
