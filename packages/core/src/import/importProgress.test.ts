// importProgress.test.ts — S-Q6's pure guards (import-redesign 09 §4): the cadence constants keep their
// contract (a 10k chunk can never exceed the delta budget; the fast floor matches the SSE throttle
// reservation) and the ONE derivation function is total, monotone-safe, and identity-honest. Pure — no db.

import { describe, expect, test } from "bun:test";
import { IMPORT_JOB_PROGRESS_THROTTLE_MS } from "@leadwolf/types";
import {
  IMPORT_PROGRESS_BATCH_ROWS,
  IMPORT_PROGRESS_MAX_DELTAS_PER_CHUNK,
  IMPORT_PROGRESS_MIN_INTERVAL_MS,
  deriveImportProgress,
  type ImportProgressSource,
} from "./importProgress.ts";

function job(partial: Partial<ImportProgressSource>): ImportProgressSource {
  return {
    status: "running",
    rowsTotal: 0,
    rowsCreated: 0,
    rowsMatched: 0,
    rowsDuplicate: 0,
    rowsSkipped: 0,
    rowsRejected: 0,
    rowsDeduped: 0,
    rowsUnprocessed: 0,
    completedChunks: 0,
    totalChunks: 0,
    ...partial,
  };
}

describe("S-Q6 cadence constants (09 §4.2) — asserted, not re-derived", () => {
  test("a 10k-row chunk writes at most the delta budget: ceil(10000 / batch) ≤ 20", () => {
    expect(Math.ceil(10_000 / IMPORT_PROGRESS_BATCH_ROWS)).toBeLessThanOrEqual(
      IMPORT_PROGRESS_MAX_DELTAS_PER_CHUNK,
    );
    expect(IMPORT_PROGRESS_BATCH_ROWS).toBeGreaterThanOrEqual(500); // the ~500–1000 band's floor
    expect(IMPORT_PROGRESS_BATCH_ROWS).toBeLessThanOrEqual(1000);
  });

  test("the fast-lane delta floor and the reserved SSE progress throttle are the SAME window (≥2s)", () => {
    expect(IMPORT_PROGRESS_MIN_INTERVAL_MS).toBe(IMPORT_JOB_PROGRESS_THROTTLE_MS);
    expect(IMPORT_PROGRESS_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(2_000);
  });
});

describe("S-Q6 deriveImportProgress — one derivation for poll, SSE, and staff", () => {
  test("terminal ⇒ percent 1; processedRows equals the accounting-identity sum", () => {
    const d = deriveImportProgress(
      job({
        status: "partial",
        rowsTotal: 10,
        rowsCreated: 5,
        rowsMatched: 2,
        rowsSkipped: 1,
        rowsRejected: 2,
        completedChunks: 1,
        totalChunks: 1,
      }),
    );
    expect(d.percent).toBe(1);
    expect(d.processedRows).toBe(10); // = rowsTotal, or the identity is violated (S1, not display)
    expect(d.stage).toBe("partial");
  });

  test("fast mode mid-run: plain rows ratio, clamped to 1", () => {
    const d = deriveImportProgress(job({ rowsTotal: 100, rowsCreated: 40, rowsSkipped: 10 }));
    expect(d.percent).toBeCloseTo(0.5);
    const over = deriveImportProgress(job({ rowsTotal: 10, rowsCreated: 25 }));
    expect(over.percent).toBe(1);
  });

  test("running with chunk plan ⇒ 'chunk i of n'; i never exceeds n", () => {
    expect(deriveImportProgress(job({ totalChunks: 12, completedChunks: 2 })).stage).toBe(
      "chunk 3 of 12",
    );
    expect(deriveImportProgress(job({ totalChunks: 4, completedChunks: 4 })).stage).toBe(
      "chunk 4 of 4",
    );
  });

  test("copy mode before rows_total lands: band ratio; pre-run states: 0 and the raw state name", () => {
    expect(deriveImportProgress(job({ totalChunks: 10, completedChunks: 5 })).percent).toBe(0.5);
    const queued = deriveImportProgress(job({ status: "queued" }));
    expect(queued.percent).toBe(0);
    expect(queued.stage).toBe("queued");
    const deferred = deriveImportProgress(job({ status: "deferred" }));
    expect(deferred.stage).toBe("deferred");
  });

  test("total: an unknown future state degrades gracefully (poll must always answer, 09 §4.3)", () => {
    const d = deriveImportProgress(job({ status: "some_future_state", rowsTotal: 4, rowsCreated: 1 }));
    expect(d.percent).toBeCloseTo(0.25);
    expect(d.stage).toBe("some_future_state");
  });
});
