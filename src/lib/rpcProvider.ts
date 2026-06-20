import { ethers } from "ethers";

const PLATFORM_FEE_BPS = 100n;

export function netDonationAmount(grossWei: bigint): bigint {
  const fee = (grossWei * PLATFORM_FEE_BPS) / 10_000n;
  return grossWei - fee;
}

function isRpcUnavailable(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("-32005") ||
    msg.includes("cu limit") ||
    msg.includes("exceeded") ||
    msg.includes("paused") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("network error")
  );
}

/** Primary RPC URL — ALCHEMY_SEPOLIA_URL or SEPOLIA_RPC_URL */
export function getPrimaryRpcUrl(): string | undefined {
  return process.env.ALCHEMY_SEPOLIA_URL || process.env.SEPOLIA_RPC_URL;
}

/** Optional fallback when primary is rate-limited or paused */
export function getFallbackRpcUrl(): string | undefined {
  return process.env.SEPOLIA_RPC_FALLBACK_URL || process.env.INFURA_SEPOLIA_URL;
}

export type RpcHealth = "ok" | "degraded" | "down";

let activeProvider: ethers.JsonRpcProvider | null = null;
let activeUrl: string | null = null;
let rpcHealth: RpcHealth = "ok";
let lastRpcError: string | null = null;
let lastRpcErrorAt: string | null = null;

export function getRpcHealth() {
  return {
    status: rpcHealth,
    activeUrl: activeUrl ? activeUrl.replace(/\/v2\/[^/]+$/, "/v2/***") : null,
    lastError: lastRpcError,
    lastErrorAt: lastRpcErrorAt,
    hasFallback: Boolean(getFallbackRpcUrl()),
  };
}

function markRpcOk(url: string) {
  activeUrl = url;
  rpcHealth = "ok";
  lastRpcError = null;
}

function markRpcDegraded(url: string, err: unknown) {
  activeUrl = url;
  rpcHealth = "degraded";
  lastRpcError = String((err as { message?: string })?.message ?? err);
  lastRpcErrorAt = new Date().toISOString();
}

function markRpcDown(err: unknown) {
  rpcHealth = "down";
  lastRpcError = String((err as { message?: string })?.message ?? err);
  lastRpcErrorAt = new Date().toISOString();
}

/** Resilient JSON-RPC provider with optional fallback URL. */
export function getProvider(): ethers.JsonRpcProvider {
  const primary = getPrimaryRpcUrl();
  if (!primary) {
    throw new Error("[RPC] ALCHEMY_SEPOLIA_URL or SEPOLIA_RPC_URL is required");
  }

  if (activeProvider && activeUrl === primary && rpcHealth !== "down") {
    return activeProvider;
  }

  activeProvider = new ethers.JsonRpcProvider(primary);
  activeUrl = primary;
  return activeProvider;
}

/** Run an RPC call; on failure try fallback URL once, never throw to caller for indexer use. */
export async function withRpcFallback<T>(
  label: string,
  fn: (provider: ethers.JsonRpcProvider) => Promise<T>
): Promise<T> {
  const primary = getPrimaryRpcUrl();
  const fallback = getFallbackRpcUrl();

  if (!primary) {
    throw new Error("[RPC] No primary RPC URL configured");
  }

  const primaryProvider = getProvider();
  try {
    const result = await fn(primaryProvider);
    markRpcOk(primary);
    return result;
  } catch (primaryErr) {
    console.warn(`[RPC] ${label} failed on primary:`, primaryErr);
    markRpcDegraded(primary, primaryErr);

    if (!fallback || fallback === primary) {
      if (isRpcUnavailable(primaryErr)) markRpcDown(primaryErr);
      throw primaryErr;
    }

    try {
      const fallbackProvider = new ethers.JsonRpcProvider(fallback);
      const result = await fn(fallbackProvider);
      activeProvider = fallbackProvider;
      activeUrl = fallback;
      rpcHealth = "degraded";
      console.warn(`[RPC] ${label} recovered via fallback provider`);
      return result;
    } catch (fallbackErr) {
      console.error(`[RPC] ${label} failed on fallback:`, fallbackErr);
      markRpcDown(fallbackErr);
      throw fallbackErr;
    }
  }
}
