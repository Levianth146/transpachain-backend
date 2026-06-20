import express from "express";
import cors    from "cors";
import http    from "http";
import rateLimit from "express-rate-limit";
import { Server as IOServer } from "socket.io";
import mongoose from "mongoose";
import dotenv  from "dotenv";

import campaignRoutes  from "./routes/campaigns";
import donationRoutes  from "./routes/donations";
import ipfsRoutes      from "./routes/ipfs";
import adminRoutes     from "./routes/admin";
import orgRoutes       from "./routes/orgs";
import proposalRoutes  from "./routes/proposals";
import evidenceRoutes  from "./routes/evidence";
import { startEventListener, getIndexerStatus } from "./indexer/eventListener";
import { getRpcHealth } from "./lib/rpcProvider";
import { errorHandler } from "./middleware/errorHandler";

dotenv.config();

const app    = express();
const server = http.createServer(app);
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
const io     = new IOServer(server, {
  cors: { origin: corsOrigin }
});

// ─── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ─── Routes ───────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const indexer = getIndexerStatus();
  const rpc = getRpcHealth();
  let onChainCampaigns: number | null = null;
  try {
    if (process.env.CHARITY_CORE_ADDRESS && rpc.status !== "down") {
      const { ethers } = await import("ethers");
      const { getProvider } = await import("./lib/rpcProvider");
      const provider = getProvider();
      const core = new ethers.Contract(
        process.env.CHARITY_CORE_ADDRESS,
        ["function totalCampaigns() view returns (uint256)"],
        provider
      );
      onChainCampaigns = Number(await core.totalCampaigns());
    }
  } catch {
    /* RPC unavailable — health still returns */
  }

  const indexedCampaigns = await (async () => {
    try {
      const { Campaign } = await import("./models/Campaign");
      return await Campaign.countDocuments({});
    } catch {
      return null;
    }
  })();

  res.json({
    status: rpc.status === "down" ? "degraded" : "ok",
    chain: "sepolia",
    dataSources: {
      indexed: "MongoDB — synced from chain events (may lag if RPC paused)",
      onChainReads: "Frontend wagmi/viem — live RPC",
      metadata: "IPFS via Pinata / gateway proxy",
    },
    rpc,
    indexer: {
      ...indexer,
      indexedCampaigns,
      onChainCampaigns,
      inSync:
        onChainCampaigns != null &&
        indexedCampaigns != null &&
        onChainCampaigns === indexedCampaigns,
    },
  });
});
app.use("/campaigns",  campaignRoutes);
app.use("/donations",  donationRoutes);
app.use("/ipfs",       ipfsRoutes);
app.use("/admin",      adminRoutes);
app.use("/orgs",       orgRoutes);
app.use("/proposals",  proposalRoutes);
app.use("/evidence",   evidenceRoutes);
app.use(errorHandler);

// ─── Socket.io ────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);
  socket.on("disconnect", () => console.log(`[WS] Client disconnected: ${socket.id}`));
});

// ─── Boot ─────────────────────────────────────────────────────
async function main() {
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/transpachain";
  await mongoose.connect(mongoUri);
  console.log("[DB] MongoDB connected");

  const port = Number(process.env.PORT) || 3001;
  server.listen(port, () => console.log(`[Server] Running on http://localhost:${port}`));

  // Indexer backfill can take minutes — run after HTTP is up so /health and API stay reachable
  if ((process.env.ALCHEMY_SEPOLIA_URL || process.env.SEPOLIA_RPC_URL) && process.env.CHARITY_CORE_ADDRESS) {
    void startEventListener(io).catch((err) =>
      console.error("[Indexer] Event listener failed:", err)
    );
  } else {
    console.warn("[Indexer] Env vars not set — skipping event listener");
  }
}

main().catch(console.error);