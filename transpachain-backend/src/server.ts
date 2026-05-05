import express from "express";
import cors    from "cors";
import http    from "http";
import { Server as IOServer } from "socket.io";
import mongoose from "mongoose";
import dotenv  from "dotenv";

import campaignRoutes  from "./routes/campaigns";
import donationRoutes  from "./routes/donations";
import ipfsRoutes      from "./routes/ipfs";
import { startEventListener } from "./indexer/eventListener";

dotenv.config();

const app    = express();
const server = http.createServer(app);
const io     = new IOServer(server, {
  cors: { origin: process.env.CORS_ORIGIN || "http://localhost:3000" }
});

// ─── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3000" }));
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", chain: "sepolia" }));
app.use("/campaigns",  campaignRoutes);
app.use("/donations",  donationRoutes);
app.use("/ipfs",       ipfsRoutes);

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

  // Start blockchain event listener
  if (process.env.ALCHEMY_SEPOLIA_URL && process.env.CHARITY_CORE_ADDRESS) {
    await startEventListener(io);
  } else {
    console.warn("[Indexer] Env vars not set — skipping event listener");
  }

  const port = Number(process.env.PORT) || 3001;
  server.listen(port, () => console.log(`[Server] Running on http://localhost:${port}`));
}

main().catch(console.error);
