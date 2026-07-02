// tuning.test.ts — proves the failure-containment tuning invariants (worker-platform plan 15 §3.3): the
// spend path stays serial (re-audit F3 — this test is the deliberate tripwire a future concurrency raise
// must trip and consciously change), every event queue has explicit lock/stall settings, every event queue
// has a deadline, and sweeps are explicitly serial. Pure — no env/Redis.

import { expect, test } from "bun:test";
import {
  EVENT_WORKER_TUNING,
  PROCESSOR_DEADLINE_MS,
  SPEND_PATH_QUEUES,
  SWEEP_WORKER_TUNING,
  deadlineMs,
  eventTuning,
} from "./tuning.ts";

test("F3 tripwire: spend-path queues are pinned at concurrency 1 until the atomic budget breaker lands", () => {
  // Raising this requires the atomic daily/workspace budget breaker + the per-batch credit lease
  // (plan 15 §7 Phase-5 hard entry gate). Changing this test IS the conscious gate-crossing act.
  const raised = SPEND_PATH_QUEUES.filter((q) => (EVENT_WORKER_TUNING[q]?.concurrency ?? 0) !== 1);
  expect(raised).toEqual([]);
  expect(SPEND_PATH_QUEUES).toContain("enrichment");
});

test("every event queue has explicit lock/stall containment settings", () => {
  const missing = Object.entries(EVENT_WORKER_TUNING)
    .filter(
      ([, t]) =>
        (t.lockDuration ?? 0) <= 0 ||
        (t.stalledInterval ?? 0) <= 0 ||
        (t.maxStalledCount ?? 0) <= 0 ||
        (t.concurrency ?? 0) <= 0,
    )
    .map(([queue]) => queue);
  expect(missing).toEqual([]);
});

test("every event queue has a positive processor deadline", () => {
  const missing = Object.keys(EVENT_WORKER_TUNING).filter(
    (queue) => (PROCESSOR_DEADLINE_MS[queue] ?? 0) <= 0,
  );
  expect(missing).toEqual([]);
});

test("dsar and imports stay strictly serial (privileged deletes; whole-CSV memory)", () => {
  expect(EVENT_WORKER_TUNING.dsar?.concurrency).toBe(1);
  expect(EVENT_WORKER_TUNING.imports?.concurrency).toBe(1);
});

test("sweep workers are explicitly serial — leader-locked singletons by design", () => {
  expect(SWEEP_WORKER_TUNING.concurrency).toBe(1);
});

test("lookups fail loudly on an unregistered queue (boot-time typo protection)", () => {
  expect(() => eventTuning("no-such-queue")).toThrow("no event tuning registered");
  expect(() => deadlineMs("no-such-queue")).toThrow("no processor deadline registered");
  expect(eventTuning("dedup").concurrency).toBe(4);
  expect(deadlineMs("scoring")).toBe(60_000);
});
