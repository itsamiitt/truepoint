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

  return `${lines.join("\n")}\n`;
}
