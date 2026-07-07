// @forge/core observability — P8 (15-observability). The DATA + SYSTEM planes: a metrics registry + Prometheus
// text renderer (mirrors TruePoint collectWorkerMetricsText, ecosystem-facts §C), per-stage freshness SLOs
// (latency-percentile budgets [S64]), and a SYMPTOM-based alert classifier — alert on retry-exhaustion /
// backlog growth / drift, NOT on the first transient failure [S101][S102]. Pure + unit-testable; the OTel
// collector, dashboards, and alarm store are deploy-time (owned by 15/16).

// ── metrics registry + Prometheus renderer ────────────────────────────────────────────────────────────
export interface MetricSample {
  name: string;
  value: number;
  labels?: Record<string, string>;
}

/** Render Prometheus exposition text (bounded-cardinality, PII-free labels only — 15 §metrics catalog). */
export function renderPrometheus(samples: MetricSample[]): string {
  return samples
    .map((s) => {
      const labels = s.labels
        ? `{${Object.entries(s.labels)
            .map(([k, v]) => `${k}="${v}"`)
            .join(",")}}`
        : "";
      return `${s.name}${labels} ${s.value}`;
    })
    .join("\n");
}

// ── per-stage freshness SLO (latency-percentile budget [S64]) ─────────────────────────────────────────
export interface StageSlo {
  stage: string;
  budgetMs: number;
}

/** Human-review latency is NOT part of the freshness SLO — that is a bounded queue (10 §Scalability, 06). */
export const DEFAULT_SLOS: StageSlo[] = [
  { stage: "capture_ack", budgetMs: 300 },
  { stage: "parse", budgetMs: 5_000 },
  { stage: "extract", budgetMs: 30_000 },
  { stage: "sync_push", budgetMs: 60_000 },
];

export function freshnessBreached(lagMs: number, budgetMs: number): boolean {
  return lagMs > budgetMs;
}

// ── symptom-based alerting (NOT first-failure [S101][S102]) ────────────────────────────────────────────
export interface AlertInput {
  retriesExhausted: number; // count of jobs that exhausted retries → DLQ
  queueDepth: number;
  queueDepthPrev: number;
  groundingCoverage?: number; // extraction drift signal (09)
}

export interface AlertThresholds {
  backlogGrowthFactor: number; // e.g. 2 = depth doubled since last sample
  groundingFloor: number; // e.g. 0.9
}

export type AlertSignal = "retry_exhaustion" | "backlog_growth" | "grounding_drop";

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  backlogGrowthFactor: 2,
  groundingFloor: 0.9,
};

/** Fire only on user-facing symptoms; a single transient retry is normal and does NOT alert (OQ-R20). */
export function classifyAlerts(
  i: AlertInput,
  t: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): AlertSignal[] {
  const signals: AlertSignal[] = [];
  if (i.retriesExhausted > 0) signals.push("retry_exhaustion");
  if (i.queueDepthPrev > 0 && i.queueDepth >= i.queueDepthPrev * t.backlogGrowthFactor) {
    signals.push("backlog_growth");
  }
  if (i.groundingCoverage !== undefined && i.groundingCoverage < t.groundingFloor) {
    signals.push("grounding_drop");
  }
  return signals;
}

// ── KEDA-style autoscale signal (queue depth / load, NOT CPU [S104][S105]) ────────────────────────────
/** Desired workers = ceil((active + queued) / perWorkerConcurrency), clamped [min, max]. Scale-to-zero when idle. */
export function desiredWorkers(
  active: number,
  queued: number,
  perWorkerConcurrency: number,
  bounds: { min: number; max: number },
): number {
  if (active + queued === 0) return bounds.min;
  const want = Math.ceil((active + queued) / Math.max(1, perWorkerConcurrency));
  return Math.max(bounds.min, Math.min(bounds.max, want));
}
