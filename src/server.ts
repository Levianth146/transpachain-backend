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
import { withTimeout } from "./lib/withTimeout";
import { errorHandler } from "./middleware/errorHandler";

const HEALTH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.HEALTH_CHECK_TIMEOUT_MS || 5000)
);

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
  const mongoReady = mongoose.connection.readyState === 1;

  let onChainCampaigns: number | null = null;
  let onChainCheckError: string | null = null;
  try {
    if (process.env.CHARITY_CORE_ADDRESS && rpc.status !== "down") {
      const { ethers } = await import("ethers");
      const { withRpcFallback } = await import("./lib/rpcProvider");
      onChainCampaigns = Number(
        await withTimeout(
          withRpcFallback("health-totalCampaigns", async (provider) => {
            const core = new ethers.Contract(
              process.env.CHARITY_CORE_ADDRESS!,
              ["function totalCampaigns() view returns (uint256)"],
              provider
            );
            return core.totalCampaigns();
          }),
          HEALTH_TIMEOUT_MS,
          "totalCampaigns"
        )
      );
    }
  } catch (err) {
    onChainCheckError = String((err as { message?: string })?.message ?? err);
  }

  let indexedCampaigns: number | null = null;
  let indexedCheckError: string | null = null;
  if (mongoReady) {
    try {
      const { Campaign } = await import("./models/Campaign");
      indexedCampaigns = await withTimeout(
        Campaign.countDocuments({}),
        HEALTH_TIMEOUT_MS,
        "countDocuments"
      );
    } catch (err) {
      indexedCheckError = String((err as { message?: string })?.message ?? err);
    }
  }

  const degraded =
    !mongoReady || rpc.status === "down" || onChainCheckError != null;

  res.json({
    status: degraded ? "degraded" : "ok",
    chain: "sepolia",
    mongo: { ready: mongoReady },
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
      onChainCheckError,
      indexedCheckError,
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
  const port = Number(process.env.PORT) || 3001;

  server.listen(port, () => console.log(`[Server] Running on http://localhost:${port}`));

  void (async () => {
    try {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });
      console.log("[DB] MongoDB connected");

      if (
        (process.env.ALCHEMY_SEPOLIA_URL || process.env.SEPOLIA_RPC_URL) &&
        process.env.CHARITY_CORE_ADDRESS
      ) {
        await startEventListener(io);
      } else {
        console.warn("[Indexer] Env vars not set — skipping event listener");
      }
    } catch (err) {
      console.error("[Boot] MongoDB or indexer startup failed:", err);
    }
  })();
}

main().catch(console.error);