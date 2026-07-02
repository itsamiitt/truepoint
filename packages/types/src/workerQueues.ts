// workerQueues.ts — the SHARED queue-name vocabulary for the always-on event queues and their dead-letter
// queues (worker-platform plan 15 §6 — Phase 4 observability). These names were defined worker-locally
// (apps/workers/src/queues/*) because nothing outside the worker produced onto them; the admin System-Health
// probe (apps/api systemHealthProbes) now reads their live depth/DLQ counts, so the names move HERE — the
// leaf both apps already depend on — and the worker files RE-EXPORT them unchanged (the exact
// reverification.ts precedent: an additive, behavior-preserving move; every string is identical, so existing
// queued jobs still match). Queue payload contracts stay in their owning modules — this file is names only.

export const ENRICHMENT_QUEUE = "enrichment";
export const ENRICHMENT_DLQ = "enrichment-dlq";
export const SCORING_QUEUE = "scoring";
export const SCORING_DLQ = "scoring-dlq";
export const DSAR_QUEUE = "dsar";
export const DSAR_DLQ = "dsar-dlq";
export const OUTREACH_QUEUE = "outreach";
export const OUTREACH_DLQ = "outreach-dlq";
export const DEDUP_QUEUE = "dedup";
export const DEDUP_DLQ = "dedup-dlq";
export const FIRMOGRAPHICS_QUEUE = "firmographics";
export const FIRMOGRAPHICS_DLQ = "firmographics-dlq";
export const MASTER_BACKFILL_QUEUE = "master-backfill";
export const MASTER_BACKFILL_DLQ = "master-backfill-dlq";
