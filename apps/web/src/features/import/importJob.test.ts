// importJob.test.ts — pins the async-import view-model policy (16 §3.2). The backend returns 202 + a job ref
// and the real ImportSummary only arrives later via polling, so the regression this guards is the BLOCKER:
// an in-flight / queued poll result must NEVER reach the summary render path (where `summary.errors.length`
// once threw `Cannot read properties of undefined`). Pure — no React, no network. We assert: queued/active
// map to `processing` with a null summary (safe to render); failed surfaces the reason; and only a
// completed job with a real summary exposes it.

import { describe, expect, test } from "bun:test";
import type { ImportJobStatusResponse, ImportSummary } from "@leadwolf/types";
import { isTerminalPhase, viewModelFromError, viewModelFromJob } from "./importJob.ts";

const summary: ImportSummary = {
  total: 3,
  created: 2,
  matched: 1,
  skipped: 0,
  rejected: 0,
  duplicates: 0,
  addedToList: 0,
  errors: [{ row: 4, message: "bad email" }],
  rejectedRows: [],
};

/** A full status envelope (GET /imports/:jobId), defaulting to an in-progress poll with no summary yet. */
function job(over: Partial<ImportJobStatusResponse> = {}): ImportJobStatusResponse {
  return {
    jobId: "job-1",
    status: "queued",
    progress: null,
    summary: null,
    failedReason: null,
    ...over,
  };
}

describe("viewModelFromJob", () => {
  test("a queued job (the 202 shape, no summary) maps to a safe `processing` view model — never throws", () => {
    const vm = viewModelFromJob(job({ status: "queued" }));
    expect(vm.phase).toBe("processing");
    expect(vm.summary).toBeNull();
    expect(vm.error).toBeNull();
    expect(vm.jobId).toBe("job-1");
    // The crash was `summary.errors.length` on a job-ref. Prove the guard: reading errors is impossible.
    expect(vm.summary?.errors.length ?? 0).toBe(0);
  });

  test("an active job is still `processing` with a null summary", () => {
    const vm = viewModelFromJob(job({ status: "active" }));
    expect(vm.phase).toBe("processing");
    expect(vm.summary).toBeNull();
  });

  test("a completed job with a real summary exposes it as `done`", () => {
    const vm = viewModelFromJob(job({ status: "completed", summary }));
    expect(vm.phase).toBe("done");
    expect(vm.summary).toEqual(summary);
    expect(vm.summary?.errors.length).toBe(1);
  });

  test("a 'completed' status whose summary hasn't materialized yet stays `processing` (no null summary leaks to done)", () => {
    const vm = viewModelFromJob(job({ status: "completed", summary: null }));
    expect(vm.phase).toBe("processing");
    expect(vm.summary).toBeNull();
  });

  test("a failed job surfaces its reason and never a summary", () => {
    const vm = viewModelFromJob(job({ status: "failed", failedReason: "worker exploded" }));
    expect(vm.phase).toBe("failed");
    expect(vm.summary).toBeNull();
    expect(vm.error).toBe("worker exploded");
  });

  test("a failed job with no reason still fails with a sane default message", () => {
    const vm = viewModelFromJob(job({ status: "failed", failedReason: null }));
    expect(vm.phase).toBe("failed");
    expect(vm.error).toBe("Import failed.");
  });

  test("an unknown status is treated as still processing (poll on)", () => {
    const vm = viewModelFromJob(job({ status: "unknown" }));
    expect(vm.phase).toBe("processing");
  });
});

describe("isTerminalPhase", () => {
  test("only done and failed are terminal (the wizard stops polling)", () => {
    expect(isTerminalPhase("done")).toBe(true);
    expect(isTerminalPhase("failed")).toBe(true);
    expect(isTerminalPhase("processing")).toBe(false);
    expect(isTerminalPhase("submitting")).toBe(false);
    expect(isTerminalPhase("idle")).toBe(false);
  });

  test("a completed-but-summary-not-yet-readable job is NOT terminal — so polling continues, not freezes", () => {
    // The freeze bug: status "completed" with a null summary maps to `processing`, which must keep polling.
    const vm = viewModelFromJob(job({ status: "completed", summary: null }));
    expect(vm.phase).toBe("processing");
    expect(isTerminalPhase(vm.phase)).toBe(false);
  });
});

describe("viewModelFromError", () => {
  test("maps a thrown message to a failed view model with no summary", () => {
    const vm = viewModelFromError("network blip", "job-9");
    expect(vm.phase).toBe("failed");
    expect(vm.error).toBe("network blip");
    expect(vm.summary).toBeNull();
    expect(vm.jobId).toBe("job-9");
  });
});
