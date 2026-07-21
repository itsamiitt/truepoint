// tuning.test.ts — proves the failure-containment tuning invariants (worker-platform plan 15 §3.3): the
// spend path stays serial (re-audit F3 — this test is the deliberate tripwire a future concurrency raise
// must trip and consciously change), every event queue has explicit lock/stall settings, every event queue
// has a deadline, and sweeps are explicitly serial. Pure — no env/Redis.

import { expect, test } from "bun:test";
import { IMPORT_QUEUE_PRIORITY } from "@leadwolf/types";
import {
  BULK_IMPORT_KIND_DEADLINE_MS,
  EVENT_WORKER_TUNING,
  PROCESSOR_DEADLINE_MS,
  SPEND_PATH_QUEUES,
  SWEEP_WORKER_TUNING,
  bulkImportKindDeadlineMs,
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

// ── S-Q1 (import-redesign 09 §1/§3): the unified import queue's tuning tripwires — T-Q9's config half. ──

test("S-Q1 tripwire: the unified bulk-imports queue stays serial with explicit containment settings", () => {
  // Raising this is a deliberate, CI-gated tuning.ts change (09 Reconciliation #4) — changing this test IS
  // the conscious act. The fast lane's worst-case wait math (09 §1.1) assumes it.
  expect(EVENT_WORKER_TUNING["bulk-imports"]?.concurrency).toBe(1);
  expect(EVENT_WORKER_TUNING["bulk-imports"]?.lockDuration).toBe(60_000);
  expect(EVENT_WORKER_TUNING["bulk-imports"]?.stalledInterval).toBe(30_000);
  expect(EVENT_WORKER_TUNING["bulk-imports"]?.maxStalledCount).toBe(2);
});

test("S-Q1: every unified-queue job kind has a positive deadline ≤ the queue-level ceiling", () => {
  const ceiling = PROCESSOR_DEADLINE_MS["bulk-imports"] ?? 0;
  expect(ceiling).toBeGreaterThan(0);
  for (const kind of ["fast", "drive", "chunk"]) {
    const ms = BULK_IMPORT_KIND_DEADLINE_MS[kind] ?? 0;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(ceiling);
    expect(bulkImportKindDeadlineMs(kind)).toBe(ms);
  }
  // An unknown kind fails the attempt loudly — never an unbounded run.
  expect(() => bulkImportKindDeadlineMs("no-such-kind")).toThrow("no bulk-imports deadline");
  expect(() => bulkImportKindDeadlineMs(undefined)).toThrow("no bulk-imports deadline");
});

test("S-Q1: priority bands order fast ahead of copy drive ahead of copy chunk (lower = served first)", () => {
  expect(IMPORT_QUEUE_PRIORITY.fast).toBeLessThan(IMPORT_QUEUE_PRIORITY.copyDrive);
  expect(IMPORT_QUEUE_PRIORITY.copyDrive).toBeLessThan(IMPORT_QUEUE_PRIORITY.copyChunk);
  expect(IMPORT_QUEUE_PRIORITY.fast).toBeGreaterThan(0); // BullMQ: 0 = no priority, distinct semantics
});

test("lookups fail loudly on an unregistered queue (boot-time typo protection)", () => {
  expect(() => eventTuning("no-such-queue")).toThrow("no event tuning registered");
  expect(() => deadlineMs("no-such-queue")).toThrow("no processor deadline registered");
  expect(eventTuning("dedup").concurrency).toBe(4);
  expect(deadlineMs("scoring")).toBe(60_000);
});
