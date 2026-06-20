export type IndexerPhase = "idle" | "backfill" | "polling" | "error";

export interface IndexerStatus {
  phase: IndexerPhase;
  startedAt: string | null;
  lastPollAt: string | null;
  lastProcessedBlock: number | null;
  backfillFromBlock: number | null;
  backfillComplete: boolean;
  /** Events handled during historical backfill (separate from live poll counter). */
  backfillEventsProcessed: number;
  eventsProcessed: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

const status: IndexerStatus = {
  phase: "idle",
  startedAt: null,
  lastPollAt: null,
  lastProcessedBlock: null,
  backfillFromBlock: null,
  backfillComplete: false,
  backfillEventsProcessed: 0,
  eventsProcessed: 0,
  lastError: null,
  lastErrorAt: null,
};

export function getIndexerStatus(): IndexerStatus {
  return { ...status };
}

export function setIndexerPhase(phase: IndexerPhase) {
  status.phase = phase;
  if (phase === "backfill" || phase === "polling") {
    if (!status.startedAt) status.startedAt = new Date().toISOString();
  }
}

export function setBackfillFromBlock(block: number) {
  status.backfillFromBlock = block;
}

export function markBackfillComplete(lastBlock: number, eventsProcessed = 0) {
  status.backfillComplete = true;
  status.lastProcessedBlock = lastBlock;
  status.backfillEventsProcessed = eventsProcessed;
  status.phase = "polling";
}

export function addBackfillEvents(count: number) {
  status.backfillEventsProcessed += count;
}

export function markPollSuccess(block: number, eventsThisPoll: number) {
  status.lastPollAt = new Date().toISOString();
  status.lastProcessedBlock = block;
  status.eventsProcessed += eventsThisPoll;
  status.lastError = null;
  status.phase = "polling";
}

export function markIndexerError(err: unknown) {
  status.phase = "error";
  status.lastError = String((err as { message?: string })?.message ?? err);
  status.lastErrorAt = new Date().toISOString();
}
