// metrics.ts — dependency-free worker metrics (worker-platform plan 15 §6 — Phase 4). Doc 19 §1 specifies a
// CloudWatch/Grafana metrics layer; nothing was installed and this sandbox can add no dependency, so this is
// the ZERO-DEP increment: an in-process counter registry fed by instrument() plus a hand-rolled Prometheus
// text renderer served on the health server's /metrics. Scrapeable by any Prometheus-compatible collector
// today; swapping in a real client library later only replaces renderPromMetrics, not the counters' call
// sites. Counters are per-process (reset on restart) — correct Prometheus counter semantics (collectors rate()
// over resets). PII rule: label values are queue names and states only — never payloads, tenants, or errors.

/** Per-queue event counters, fed by instrument() in register.ts. */
export interface QueueCounters {
  completed: number;
  failed: number;
}

const counters = new Map<string, QueueCounters>();

function countersFor(queue: string): QueueCounters {
  let c = counters.get(queue);
  if (!c) {
    c = { completed: 0, failed: 0 };
    counters.set(queue, c);
  }
  return c;
}

export function recordCompleted(queue: string): void {
  countersFor(queue).completed += 1;
}

export function recordFailed(queue: string): void {
  countersFor(queue).failed += 1;
}

/** Snapshot for rendering/tests. */
export function countersSnapshot(): ReadonlyMap<string, QueueCounters> {
  return counters;
}

/** Test seam — counters are module-global, so tests reset between cases. */
export function resetCounters(): void {
  counters.clear();
}

// ── Import-specific metrics (import-redesign 09 §8, S-Q5/S-Q7) ──────────────────────────────────────────────
// The reaper (S-Q5) publishes point-in-time GAUGES (recomputed every tick — set, not accumulated) and
// cumulative COUNTERS. Kept in their own module-global maps so the render reads them exactly like `counters`
// (no plumbing through collectWorkerMetricsText, which only carries the live queue-depth snapshot). PII rule
// unchanged: names are static metric strings — never a jobId, tenant, or value.
const importCounters = new Map<string, number>();
const importGauges = new Map<string, number>();

/** Add to a cumulative import counter (rendered as `leadwolf_import_<name>`, e.g. `reaper_copy_redrive_total`). */
export function incrementImportCounter(name: string, by = 1): void {
  importCounters.set(name, (importCounters.get(name) ?? 0) + by);
}

/** Set a point-in-time import gauge (rendered as `leadwolf_import_<name>`, e.g. `jobs_stalled`) — the reaper
 *  overwrites it each tick, so it always reflects the latest census, never an accumulation. */
export function setImportGauge(name: string, value: number): void {
  importGauges.set(name, value);
}

/** Snapshots for tests. */
export function importCountersSnapshot(): ReadonlyMap<string, number> {
  return importCounters;
}
export function importGaugesSnapshot(): ReadonlyMap<string, number> {
  return importGauges;
}

/** Test seam — the import maps are module-global, so tests reset between cases. */
export function resetImportMetrics(): void {
  importCounters.clear();
  importGauges.clear();
}

// ── Channel-family metrics (import-redesign 05/15 §2.1 — S-CH3 backfill + S-CH5 reconcile) ─────────────────
// Same shape as the import maps (cumulative counters + point-in-time gauges, rendered as
// `leadwolf_channel_<name>`): the S-CH3 backfill sweep feeds `backfill_contacts_total` /
// `backfill_emails_total` / `backfill_phones_total` / `backfill_phone_unparseable_total` /
// `backfill_conflicts_total` / `backfill_skipped_total` and overwrites the `backfill_remaining` gauge (the
// S-CH4 completeness number) each tick. The S-CH5 reconcile sweep (05 §3.4) feeds `drift_detected_total` +
// the direction-labelled `drift_repaired_flat_total` / `drift_repaired_child_total` (flat-wins vs child-wins;
// the direction is name-encoded — the zero-dep renderer has no label support) + `drift_skipped_total`, and
// overwrites the `drift_remaining` gauge (the CH-INV-1 drift count; > 0 after burn-in = the S2 alert, runbook
// §K). PII rule unchanged: names are static strings — never a tenant, contact id, or value.
const channelCounters = new Map<string, number>();
const channelGauges = new Map<string, number>();

/** Add to a cumulative channel counter (rendered as `leadwolf_channel_<name>`). */
export function incrementChannelCounter(name: string, by = 1): void {
  channelCounters.set(name, (channelCounters.get(name) ?? 0) + by);
}

/** Set a point-in-time channel gauge (rendered as `leadwolf_channel_<name>`) — overwritten per tick. */
export function setChannelGauge(name: string, value: number): void {
  channelGauges.set(name, value);
}

/** Snapshots for tests. */
export function channelCountersSnapshot(): ReadonlyMap<string, number> {
  return channelCounters;
}
export function channelGaugesSnapshot(): ReadonlyMap<string, number> {
  return channelGauges;
}

/** Test seam — the channel maps are module-global, so tests reset between cases. */
export function resetChannelMetrics(): void {
  channelCounters.clear();
  channelGauges.clear();
}

// Account-backfill family (S-A1/S-A3; rendered as `leadwolf_account_<name>`): the leader-locked
// accountBackfillSweep feeds `backfill_domains_scanned_total` / `backfill_domains_created_total` /
// `backfill_domain_conflicts_total` (domain pass = the mandated S-A1 re-run) + `backfill_hq_scanned_total` /
// `backfill_hq_created_total` / `backfill_hq_unmapped_total` / `backfill_hq_conflicts_total` (HQ pass), and
// overwrites the `backfill_domain_remaining` gauge (THE S-A6/C2 gate, 15 §2.2) + `backfill_hq_remaining`
// (count-only) each tick. Same PII rule: names are static strings — never a tenant, account id, or value.
const accountCounters = new Map<string, number>();
const accountGauges = new Map<string, number>();

/** Add to a cumulative account counter (rendered as `leadwolf_account_<name>`). */
export function incrementAccountCounter(name: string, by = 1): void {
  accountCounters.set(name, (accountCounters.get(name) ?? 0) + by);
}

/** Set a point-in-time account gauge (rendered as `leadwolf_account_<name>`) — overwritten per tick. */
export function setAccountGauge(name: string, value: number): void {
  accountGauges.set(name, value);
}

/** Snapshots for tests. */
export function accountCountersSnapshot(): ReadonlyMap<string, number> {
  return accountCounters;
}
export function accountGaugesSnapshot(): ReadonlyMap<string, number> {
  return accountGauges;
}

/** Test seam — the account maps are module-global, so tests reset between cases. */
export function resetAccountMetrics(): void {
  accountCounters.clear();
  accountGauges.clear();
}

/** One queue's live depth reading (gathered by register.ts from its producer handles, bounded). */
export interface QueueDepth {
  queue: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
}

export interface WorkerMetricsInput {
  depths: QueueDepth[];
  /** Age of the oldest unpublished worker_outbox row (relay lag, re-audit F1) — null when drained/unknown. */
  outboxOldestPendingSeconds: number | null;
}

/** Escape a Prometheus label value (backslash, quote, newline — the exposition-format escape set). */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Render the Prometheus text exposition (version 0.0.4). Pure — fully unit-testable. Metric families:
 *   leadwolf_worker_jobs_completed_total / _failed_total   (counters, per queue)
 *   leadwolf_worker_queue_jobs                             (gauge, per queue × state)
 *   leadwolf_worker_outbox_oldest_pending_seconds          (gauge; absent when null — never a fake 0)
 */
export function renderPromMetrics(input: WorkerMetricsInput): string {
  const lines: string[] = [];

  lines.push("# TYPE leadwolf_worker_jobs_completed_total counter");
  lines.push("# TYPE leadwolf_worker_jobs_failed_total counter");
  for (const [queue, c] of counters) {
    lines.push(`leadwolf_worker_jobs_completed_total{queue="${esc(queue)}"} ${c.completed}`);
    lines.push(`leadwolf_worker_jobs_failed_total{queue="${esc(queue)}"} ${c.failed}`);
  }

  lines.push("# TYPE leadwolf_worker_queue_jobs gauge");
  for (const d of input.depths) {
    const q = esc(d.queue);
    lines.push(`leadwolf_worker_queue_jobs{queue="${q}",state="waiting"} ${d.waiting}`);
    lines.push(`leadwolf_worker_queue_jobs{queue="${q}",state="active"} ${d.active}`);
    lines.push(`leadwolf_worker_queue_jobs{queue="${q}",state="failed"} ${d.failed}`);
    lines.push(`leadwolf_worker_queue_jobs{queue="${q}",state="delayed"} ${d.delayed}`);
  }

  if (input.outboxOldestPendingSeconds !== null) {
    lines.push("# TYPE leadwolf_worker_outbox_oldest_pending_seconds gauge");
    lines.push(`leadwolf_worker_outbox_oldest_pending_seconds ${input.outboxOldestPendingSeconds}`);
  }

  // Import reaper counters + gauges (S-Q5/S-Q7). Rendered from the module-global maps, like the queue counters.
  // Reserved (defined by the sibling's S-Q4, NOT here — one owner per name): the notify delivery-lag gauge
  // `leadwolf_import_notify_delivery_lag_seconds`. This renderer must never double-define it.
  for (const [name, value] of importCounters) {
    lines.push(`# TYPE leadwolf_import_${name} counter`);
    lines.push(`leadwolf_import_${name} ${value}`);
  }
  for (const [name, value] of importGauges) {
    lines.push(`# TYPE leadwolf_import_${name} gauge`);
    lines.push(`leadwolf_import_${name} ${value}`);
  }

  // Channel-family counters + gauges (S-CH3 backfill) — same module-global-map rendering.
  for (const [name, value] of channelCounters) {
    lines.push(`# TYPE leadwolf_channel_${name} counter`);
    lines.push(`leadwolf_channel_${name} ${value}`);
  }
  for (const [name, value] of channelGauges) {
    lines.push(`# TYPE leadwolf_channel_${name} gauge`);
    lines.push(`leadwolf_channel_${name} ${value}`);
  }

  // Account-backfill family (S-A1/S-A3) — same module-global-map rendering.
  for (const [name, value] of accountCounters) {
    lines.push(`# TYPE leadwolf_account_${name} counter`);
    lines.push(`leadwolf_account_${name} ${value}`);
  }
  for (const [name, value] of accountGauges) {
    lines.push(`# TYPE leadwolf_account_${name} gauge`);
    lines.push(`leadwolf_account_${name} ${value}`);
  }

  return `${lines.join("\n")}\n`;
}
