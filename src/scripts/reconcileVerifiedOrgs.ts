import dotenv from "dotenv";
import mongoose from "mongoose";
import { syncVerifiedOrgsFromEvents } from "../lib/reconcileVerifiedOrgs";

dotenv.config();

async function main() {
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/transpachain";
  await mongoose.connect(mongoUri);
  console.log("[Reconcile] Connected to MongoDB");

  const result = await syncVerifiedOrgsFromEvents();
  console.log(JSON.stringify(result, null, 2));

  await mongoose.disconnect();
  process.exit(result.errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
