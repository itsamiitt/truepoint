// metrics.test.ts — proves the zero-dep metrics layer (worker-platform plan 15 §6): counter accumulation,
// Prometheus text rendering (families, labels, escaping), and the no-fake-zero rule for the outbox-lag gauge.
// Pure — no Redis/DB.

import { beforeEach, expect, test } from "bun:test";
import {
  countersSnapshot,
  incrementImportCounter,
  recordCompleted,
  recordFailed,
  renderPromMetrics,
  resetCounters,
  resetImportMetrics,
  setImportGauge,
} from "./metrics.ts";

beforeEach(() => {
  resetCounters();
  resetImportMetrics();
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

test("import reaper counters + gauges render as leadwolf_import_* families (S-Q5/S-Q7)", () => {
  incrementImportCounter("reaper_copy_redrive_total", 2);
  incrementImportCounter("reaper_copy_redrive_total"); // +1 → 3 (cumulative)
  setImportGauge("jobs_stalled", 1);
  setImportGauge("jobs_accounting_violations", 0);
  const text = renderPromMetrics({ depths: [], outboxOldestPendingSeconds: null });
  expect(text).toContain("# TYPE leadwolf_import_reaper_copy_redrive_total counter");
  expect(text).toContain("leadwolf_import_reaper_copy_redrive_total 3");
  expect(text).toContain("# TYPE leadwolf_import_jobs_stalled gauge");
  expect(text).toContain("leadwolf_import_jobs_stalled 1");
  // A zero gauge DOES render (a 0-violations reading is a real, asserted signal — unlike the honest-unknown
  // outbox lag, which omits on null).
  expect(text).toContain("leadwolf_import_jobs_accounting_violations 0");
});

test("import metrics gauges are set (overwrite), counters accumulate", () => {
  setImportGauge("jobs_stalled", 5);
  setImportGauge("jobs_stalled", 2); // overwrite, not accumulate
  incrementImportCounter("reaper_fast_orphan_failed_total", 1);
  incrementImportCounter("reaper_fast_orphan_failed_total", 1); // accumulate
  const text = renderPromMetrics({ depths: [], outboxOldestPendingSeconds: null });
  expect(text).toContain("leadwolf_import_jobs_stalled 2");
  expect(text).toContain("leadwolf_import_reaper_fast_orphan_failed_total 2");
});
