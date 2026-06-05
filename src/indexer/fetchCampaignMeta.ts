export interface CampaignMeta {
  title: string;
  description: string;
  category: string;
  imageUrl: string;
  orgName: string;
}

const EMPTY_META: CampaignMeta = {
  title: "",
  description: "",
  category: "general",
  imageUrl: "",
  orgName: "",
};

const IPFS_GATEWAYS = [
  (cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`,
  (cid: string) => `https://ipfs.io/ipfs/${cid}`,
  (cid: string) => `https://cloudflare-ipfs.com/ipfs/${cid}`,
];

const RETRY_DELAY_MS = 2000;
const MAX_ATTEMPTS = 3;

function normalizeImageUrl(raw?: string): string {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length < 6) return "";
  if (trimmed.startsWith("ipfs://")) {
    const cid = trimmed.slice(7).replace(/^ipfs\//, "");
    return cid ? `https://gateway.pinata.cloud/ipfs/${cid}` : "";
  }
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|ba[a-z2-7]{56,}|baf[a-z2-7]+)$/i.test(trimmed)) {
    return `https://gateway.pinata.cloud/ipfs/${trimmed}`;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (!url.hostname.includes(".") && url.hostname !== "localhost") return "";
      return trimmed;
    } catch {
      return "";
    }
  }
  return "";
}

function parseMeta(json: Record<string, string>): CampaignMeta {
  return {
    title: json.title || "",
    description: json.description || "",
    category: json.category || "general",
    imageUrl: normalizeImageUrl(json.imageUrl) || "",
    orgName: json.orgName || "",
  };
}

async function fetchFromGateway(url: string): Promise<CampaignMeta | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const json = (await res.json()) as Record<string, string>;
  return parseMeta(json);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch campaign metadata from IPFS with gateway fallbacks and retries.
 * Logs clearly when all attempts fail so empty-title campaigns can be diagnosed.
 */
export async function fetchCampaignMeta(
  metadataCID: string,
  campaignId?: number
): Promise<CampaignMeta> {
  if (!metadataCID) return { ...EMPTY_META };

  const label = campaignId !== undefined ? `campaign #${campaignId}` : `CID ${metadataCID}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    for (const gateway of IPFS_GATEWAYS) {
      const url = gateway(metadataCID);
      try {
        const meta = await fetchFromGateway(url);
        if (meta && meta.title) {
          if (attempt > 1) {
            console.log(`[Indexer] IPFS metadata for ${label} succeeded on attempt ${attempt}`);
          }
          return meta;
        }
        if (meta && !meta.title) {
          console.warn(`[Indexer] IPFS metadata for ${label} missing title field (gateway: ${url})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Indexer] IPFS fetch failed for ${label} via ${url}: ${msg}`);
      }
    }

    if (attempt < MAX_ATTEMPTS) {
      console.warn(
        `[Indexer] Retrying IPFS metadata for ${label} (attempt ${attempt + 1}/${MAX_ATTEMPTS})…`
      );
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  console.error(
    `[Indexer] All IPFS gateways failed for ${label} (CID: ${metadataCID}). ` +
      `Campaign will be indexed without metadata — re-run backfill or fix gateway access.`
  );
  return { ...EMPTY_META };
}
