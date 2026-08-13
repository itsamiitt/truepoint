// piiLogTripwire.test.ts — pin the S-S6 PII-in-logs tripwire's ability to FAIL.
//
// WHY THIS EXISTS. `scripts/lint-import-pii-logs.mjs` guards 13 §3.5: an import- or ingest-path log call may
// carry codes, ids and counts, never a raw row. It passes on a clean tree, which tells you nothing on its own —
// a tripwire that cannot fire also passes on a clean tree, and that is not hypothetical here. When the ingest
// roots were added to it, the gate reported "clean" over the newly-covered files because no FORBIDDEN pattern
// matched ingest's vocabulary (`records`, `observations`). The files were scanned, nothing matched, and the
// green check meant nothing. Caught only by planting a leak by hand.
//
// This makes that check repeatable. It reads the script's own FORBIDDEN table and asserts each pattern still
// matches the shape it was written for, that the safe shapes stay unmatched, and that every ROOT's payload
// vocabulary is actually represented — which is the specific hole that shipped.
//
// WHY IT LIVES HERE rather than beside the script: CI discovers unit tests with
// `find packages apps -name '*.test.ts'`, so a test under scripts/ would never run. This directory is where
// the discipline the tripwire enforces is documented, which makes it the least-arbitrary home inside that
// search path.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../../scripts/lint-import-pii-logs.mjs");
const src = readFileSync(SCRIPT, "utf8");

/** The `re:` literals from the script's FORBIDDEN table, compiled here so the test binds to the real source. */
function forbiddenPatterns(): RegExp[] {
  const table = src.slice(
    src.indexOf("const FORBIDDEN = ["),
    src.indexOf("];", src.indexOf("const FORBIDDEN = [")),
  );
  const out: RegExp[] = [];
  for (const m of table.matchAll(/\{\s*re:\s*\/(.+?)\/([gimsuy]*)\s*,/g)) {
    out.push(new RegExp(m[1] as string, m[2] as string));
  }
  return out;
}

/** Does ANY forbidden pattern match this log-argument text? */
function flagged(argText: string): boolean {
  return forbiddenPatterns().some((re) => re.test(argText));
}

describe("the FORBIDDEN table is non-empty and parseable", () => {
  test("patterns were extracted from the real script", () => {
    // If this drops to zero the rest of the file silently passes on everything, which is the exact failure
    // mode being guarded against.
    expect(forbiddenPatterns().length).toBeGreaterThanOrEqual(8);
  });
});

describe("known PII carriers are caught", () => {
  const LEAKS: ReadonlyArray<readonly [label: string, arg: string]> = [
    ["import: raw parsed row", "{ jobId, rawData }"],
    ["import: .raw payload", "{ jobId, value: row.raw }"],
    ["import: ledger input", "{ jobId, input }"],
    ["import: parsed rows array", "{ jobId, rows: parsed.rows }"],
    ["import: filename as typed", "{ jobId, fileName }"],
    ["import: request body", "{ jobId, body: req.body }"],
    ["channel value: email", "{ email: contact.email }"],
    ["channel value: phone", "{ phone: '+15550100' }"],
    // The three that were missing when the ingest roots landed. Without these, adding those roots gave the
    // APPEARANCE of coverage and none of the substance.
    // Each fixture must match exactly ONE pattern, or the suite cannot detect a single carrier being
    // removed. The first version used "{ records: parsed.data.records }", which matches BOTH `records:` and
    // `.records` — deleting either left the other covering it and the test stayed green. Found by deleting
    // one and expecting a failure that did not come.
    ["ingest: records: key alone", "{ records: capturedList }"],
    ["ingest: .records accessor alone", "{ n: envelope.records }"],
    ["ingest: parsed observations", "{ observations }"],
  ];

  for (const [label, arg] of LEAKS) {
    test(`flags ${label}`, () => {
      expect(flagged(arg)).toBe(true);
    });
  }
});

describe("safe shapes are not flagged", () => {
  // 13 §3.5 permits exactly these: codes, ids and counts. If one of these starts failing, a pattern has been
  // widened too far and the gate will cry wolf until someone disables it.
  const SAFE: ReadonlyArray<readonly [label: string, arg: string]> = [
    ["job + workspace ids", "{ jobId, workspaceId }"],
    ["an error code", '{ jobId, code: "row_invalid" }'],
    ["counts", "{ jobId, accepted: 12, rejected: 3 }"],
    ["a hyphenated message string", '{ jobId, stage: "rejected-rows" }'],
    ["a tenant id", "{ tenantId, durationMs }"],
  ];

  for (const [label, arg] of SAFE) {
    test(`allows ${label}`, () => {
      expect(flagged(arg)).toBe(false);
    });
  }
});

describe("every scanned root's vocabulary is represented", () => {
  test("the ingest roots are still in ROOTS", () => {
    // Roots and carriers must move together. Either alone is a silent gap: roots without carriers scans files
    // nothing can match, carriers without roots matches shapes in files nobody scans.
    expect(src).toContain("apps/api/src/features/ingest");
    expect(src).toContain("packages/core/src/ingestion");
  });

  test("the import roots are still in ROOTS", () => {
    expect(src).toContain("packages/core/src/import");
    expect(src).toContain("apps/api/src/features/import");
    expect(src).toContain("apps/workers/src/queues");
  });
});
