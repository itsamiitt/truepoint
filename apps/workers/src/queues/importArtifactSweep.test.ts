// importArtifactSweep.test.ts — CI-RUN unit tests for the S-S7 sweep's PURE deciders (the importReaperSweep
// test pattern): the TTL cutoff math and the key list one lapsed job expires (tracked pair + the
// deterministic legacy rejected-rows key; the source object NEVER rides the TTL — it follows the job's own
// purge horizon, 13 §4.4). The end-to-end sweep (real rows + store) is CI-owed with the itest suite.

import { describe, expect, test } from "bun:test";
import {
  type ArtifactExpiryCandidate,
  artifactExpiryCutoff,
  artifactKeysToExpire,
} from "./importArtifactSweep.ts";

const candidate = (over?: Partial<ArtifactExpiryCandidate>): ArtifactExpiryCandidate => ({
  id: "0198ad00-0000-7000-8000-000000000001",
  tenantId: "t",
  workspaceId: "w",
  rejectedArtifactKey: "imports/0198ad00-0000-7000-8000-000000000001/repair.csv",
  errorReportKey: "imports/0198ad00-0000-7000-8000-000000000001/errors.csv",
  ...over,
});

describe("artifactExpiryCutoff", () => {
  test("90-day default: the cutoff is exactly ttlDays ago", () => {
    const now = Date.UTC(2026, 6, 5, 12, 0, 0);
    expect(artifactExpiryCutoff(now, 90).getTime()).toBe(now - 90 * 24 * 60 * 60_000);
  });

  test("a job completed just inside the TTL is NOT past the cutoff; just outside IS", () => {
    const now = Date.UTC(2026, 6, 5);
    const cutoff = artifactExpiryCutoff(now, 90);
    const inside = new Date(now - 89 * 24 * 60 * 60_000);
    const outside = new Date(now - 91 * 24 * 60 * 60_000);
    expect(inside < cutoff).toBe(false); // survives (the repo predicate is completed_at < cutoff)
    expect(outside < cutoff).toBe(true); // lapses
  });
});

describe("artifactKeysToExpire", () => {
  test("both tracked keys + the legacy rejected-rows key; NEVER the source object", () => {
    const keys = artifactKeysToExpire(candidate());
    expect(keys).toEqual([
      "imports/0198ad00-0000-7000-8000-000000000001/repair.csv",
      "imports/0198ad00-0000-7000-8000-000000000001/errors.csv",
      "imports/0198ad00-0000-7000-8000-000000000001/rejected-rows.csv",
    ]);
    expect(keys.some((k) => k.includes("source"))).toBe(false);
  });

  test("repair-only job (error-report store write failed at terminal) expires just the one + legacy", () => {
    const keys = artifactKeysToExpire(candidate({ errorReportKey: null }));
    expect(keys).toEqual([
      "imports/0198ad00-0000-7000-8000-000000000001/repair.csv",
      "imports/0198ad00-0000-7000-8000-000000000001/rejected-rows.csv",
    ]);
  });

  test("errors-only job (repair write failed) mirrors it", () => {
    const keys = artifactKeysToExpire(candidate({ rejectedArtifactKey: null }));
    expect(keys[0]).toBe("imports/0198ad00-0000-7000-8000-000000000001/errors.csv");
    expect(keys).toHaveLength(2);
  });

  test("the legacy key always rides (untracked in the DB; absent-object delete is a no-op)", () => {
    const keys = artifactKeysToExpire(candidate({ rejectedArtifactKey: null, errorReportKey: null }));
    expect(keys).toEqual(["imports/0198ad00-0000-7000-8000-000000000001/rejected-rows.csv"]);
  });
});
