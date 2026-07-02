// metrics.test.ts — proves the zero-dep metrics layer (worker-platform plan 15 §6): counter accumulation,
// Prometheus text rendering (families, labels, escaping), and the no-fake-zero rule for the outbox-lag gauge.
// Pure — no Redis/DB.

import { beforeEach, expect, test } from "bun:test";
import {
  countersSnapshot,
  recordCompleted,
  recordFailed,
  renderPromMetrics,
  resetCounters,
} from "./metrics.ts";

beforeEach(() => {
  resetCounters();
});

test("counters accumulate per queue", () => {
  recordCompleted("imports");
  recordCompleted("imports");
  recordFailed("imports");
  recordCompleted("dedup");
  expect(countersSnapshot().get("imports")).toEqual({ completed: 2, failed: 1 });
  expect(countersSnapshot().get("dedup")).toEqual({ completed: 1, failed: 0 });
});

test("renders counter + depth gauge families in Prometheus text format", () => {
  recordCompleted("imports");
  recordFailed("imports");
  const text = renderPromMetrics({
    depths: [{ queue: "imports", waiting: 3, active: 1, failed: 2, delayed: 0 }],
    outboxOldestPendingSeconds: 12.5,
  });
  expect(text).toContain("# TYPE leadwolf_worker_jobs_completed_total counter");
  expect(text).toContain('leadwolf_worker_jobs_completed_total{queue="imports"} 1');
  expect(text).toContain('leadwolf_worker_jobs_failed_total{queue="imports"} 1');
  expect(text).toContain('leadwolf_worker_queue_jobs{queue="imports",state="waiting"} 3');
  expect(text).toContain('leadwolf_worker_queue_jobs{queue="imports",state="delayed"} 0');
  expect(text).toContain("leadwolf_worker_outbox_oldest_pending_seconds 12.5");
  expect(text.endsWith("\n")).toBe(true);
});

test("a null outbox lag omits the gauge entirely — never a fabricated 0 (honest-unknown rule)", () => {
  const text = renderPromMetrics({ depths: [], outboxOldestPendingSeconds: null });
  expect(text).not.toContain("leadwolf_worker_outbox_oldest_pending_seconds");
});

test("label values are escaped per the exposition format", () => {
  recordCompleted('we"ird\\queue\nname');
  const text = renderPromMetrics({ depths: [], outboxOldestPendingSeconds: null });
  expect(text).toContain('queue="we\\"ird\\\\queue\\nname"');
});
