// types.ts — the enrichment-jobs slice's view models. The status surface is a server contract (G-ENR-4): GET
// /enrichment/jobs returns EnrichmentJobSummary[] and GET /enrichment/jobs/:jobId returns one. We re-export the
// inferred types from @leadwolf/types so the slice has one local import surface. Non-PII (counters + filename).
export type {
  EnrichmentJobCounts,
  EnrichmentJobStatus,
  EnrichmentJobSummary,
} from "@leadwolf/types";

/** A job whose status is terminal — no further polling needed once every visible job is in one of these. */
export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;
