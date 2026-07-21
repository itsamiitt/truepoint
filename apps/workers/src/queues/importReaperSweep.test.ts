// importReaperSweep.test.ts — proves the S-Q5 reaper's PURE recovery decision (T-Q5) + the orphan-liveness
// prefix match. The I/O processor (leader lock, DB, queue) is not exercised here; the decider carries the
// load-bearing logic (which jobs recover, which terminalize, which are left alone), so it is unit-tested in
// isolation. The stall-window boundary (T-Q8) is proven at the decider's `stalled` input contract.

import { expect, test } from "bun:test";
import {
  type ReaperCandidate,
  decideReaperAction,
  draftReapCutoff,
  hasLiveFastJob,
  isDraftSourceObjectKey,
} from "./importReaperSweep.ts";

const GRACE = 5 * 60_000;
const now = 1_000_000_000_000;
const old = new Date(now - GRACE - 1); // just past the orphan grace
const fresh = new Date(now - 1_000); // well within grace

function job(over: Partial<ReaperCandidate>): ReaperCandidate {
  return {
    id: "J1",
    tenantId: "t1",
    workspaceId: "w1",
    status: "queued",
    processingMode: "fast",
    createdAt: old,
    rowsTotal: 10,
    processed: 0,
    ...over,
  };
}

const NONE: ReadonlySet<string> = new Set();

test("hasLiveFastJob matches the base id and any :r<n> deferred variant", () => {
  expect(hasLiveFastJob(new Set(["import-fast:J1"]), "J1")).toBe(true);
  expect(hasLiveFastJob(new Set(["import-fast:J1:r3"]), "J1")).toBe(true);
  expect(hasLiveFastJob(new Set(["import-fast:J1X"]), "J1")).toBe(false); // no false prefix
  expect(hasLiveFastJob(new Set(["import-drive:J1"]), "J1")).toBe(false);
  expect(hasLiveFastJob(NONE, "J1")).toBe(false);
});

test("fast: orphaned (no live job, past grace, non-terminal) → honest terminal", () => {
  for (const status of ["queued", "validating", "running"]) {
    expect(
      decideReaperAction(job({ status }), { liveIds: NONE, now, orphanGraceMs: GRACE, stalled: false }),
    ).toBe("fast_orphan_fail");
  }
});

test("fast: a live base job is never terminalized", () => {
  expect(
    decideReaperAction(job({ status: "running" }), {
      liveIds: new Set(["import-fast:J1"]),
      now,
      orphanGraceMs: GRACE,
      stalled: false,
    }),
  ).toBe("none");
});

test("fast: a promoted-deferred job with a live :r<n> transport is NOT a false orphan", () => {
  expect(
    decideReaperAction(job({ status: "queued" }), {
      liveIds: new Set(["import-fast:J1:r2"]),
      now,
      orphanGraceMs: GRACE,
      stalled: false,
    }),
  ).toBe("none");
});

test("fast: within the grace window is left alone (a merely-slow claim, not an orphan)", () => {
  expect(
    decideReaperAction(job({ status: "queued", createdAt: fresh }), {
      liveIds: NONE,
      now,
      orphanGraceMs: GRACE,
      stalled: false,
    }),
  ).toBe("none");
});

test("deferred is never touched by the reaper (the promotion sweep owns it)", () => {
  expect(
    decideReaperAction(job({ status: "deferred", processingMode: "fast" }), {
      liveIds: NONE,
      now,
      orphanGraceMs: GRACE,
      stalled: false,
    }),
  ).toBe("none");
  expect(
    decideReaperAction(job({ status: "deferred", processingMode: "copy" }), {
      liveIds: NONE,
      now,
      orphanGraceMs: GRACE,
      stalled: false,
    }),
  ).toBe("none");
});

test("copy: queued/staged with no live drive past grace → re-drive (idempotent recovery)", () => {
  for (const status of ["queued", "staged"]) {
    expect(
      decideReaperAction(job({ status, processingMode: "copy" }), {
        liveIds: NONE,
        now,
        orphanGraceMs: GRACE,
        stalled: false,
      }),
    ).toBe("copy_redrive");
  }
});

test("copy: a live drive is never re-driven", () => {
  expect(
    decideReaperAction(job({ status: "queued", processingMode: "copy" }), {
      liveIds: new Set(["import-drive:J1"]),
      now,
      orphanGraceMs: GRACE,
      stalled: false,
    }),
  ).toBe("none");
});

test("copy: a running job re-drives ONLY when stalled (a healthy moving job is left alone)", () => {
  const running = job({ status: "running", processingMode: "copy" });
  expect(
    decideReaperAction(running, { liveIds: NONE, now, orphanGraceMs: GRACE, stalled: false }),
  ).toBe("none");
  expect(
    decideReaperAction(running, { liveIds: NONE, now, orphanGraceMs: GRACE, stalled: true }),
  ).toBe("copy_redrive");
});

test("copy: fast-orphan terminal is never chosen for a copy job (rows are reconstructable)", () => {
  expect(
    decideReaperAction(job({ status: "running", processingMode: "copy" }), {
      liveIds: NONE,
      now,
      orphanGraceMs: GRACE,
      stalled: false,
    }),
  ).not.toBe("fast_orphan_fail");
});

// ── S-I8 draft-reap deciders (T12's unit leg — the cutoff + the object-key discriminator) ──────────────

test("draftReapCutoff: exactly TTL ago is NOT yet reapable; a moment older is", () => {
  const ttl = 48 * 3_600_000; // the 08 §Edge cases default (IMPORT_DRAFT_TTL_HOURS = 48)
  const cutoff = draftReapCutoff(now, ttl);
  expect(cutoff.getTime()).toBe(now - ttl);
  // The census predicate is created_at < cutoff (strict): the boundary instant survives one more tick.
  expect(new Date(now - ttl).getTime() < cutoff.getTime()).toBe(false);
  expect(new Date(now - ttl - 1).getTime() < cutoff.getTime()).toBe(true);
});

test("draft: never reaped by the orphan decider (drafts are the DRAFT reap's, never fast_orphan_fail)", () => {
  // listNonTerminalImportJobs never enumerates drafts, but the decider must also be safe by construction.
  expect(
    decideReaperAction(job({ status: "draft", processingMode: null, createdAt: old }), {
      liveIds: NONE,
      now,
      orphanGraceMs: GRACE,
      stalled: false,
    }),
  ).toBe("none");
});

test("isDraftSourceObjectKey: real store keys yes; inline:/retry: sentinels never", () => {
  expect(isDraftSourceObjectKey("imports/0e8a4c1e/source.csv")).toBe(true);
  expect(isDraftSourceObjectKey("imports/0e8a4c1e/source.xlsx")).toBe(true);
  expect(isDraftSourceObjectKey("inline:0e8a4c1e-uuid")).toBe(false);
  expect(isDraftSourceObjectKey("retry:0e8a4c1e-uuid")).toBe(false);
  expect(isDraftSourceObjectKey("")).toBe(false);
});
