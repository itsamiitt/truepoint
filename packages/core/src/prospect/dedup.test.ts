// dedup.test.ts — the PURE dedup logic (24 Phase-0.5): the grouping key, completeness score, canonical pick,
// and group computation. No DB (runDedup's tx path is covered by the db itest). Env is seeded by the global
// test preload, so importing the module (→ @leadwolf/db lazy client, @leadwolf/config) is safe here.

import { describe, expect, test } from "bun:test";
import type { DedupContactRow } from "@leadwolf/db";
import { completenessScore, computeDuplicateGroups, dedupKey, pickCanonical } from "./dedup.ts";

const mk = (over: Partial<DedupContactRow> = {}): DedupContactRow => ({
  id: "00000000-0000-0000-0000-000000000001",
  firstName: "Jane",
  lastName: "Doe",
  emailDomain: "acme.com",
  jobTitle: null,
  linkedinUrl: null,
  seniorityLevel: null,
  department: null,
  locationCountry: null,
  hasPhone: false,
  isRevealed: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

describe("dedupKey", () => {
  test("same name + same registrable domain → identical key (subdomain folds to eTLD+1)", () => {
    expect(dedupKey(mk({ emailDomain: "acme.com" }))).toBe(
      dedupKey(mk({ emailDomain: "mail.acme.com" })),
    );
  });
  test("accents/case fold so 'José' and 'jose' collide", () => {
    expect(dedupKey(mk({ firstName: "José", lastName: "Díaz" }))).toBe(
      dedupKey(mk({ firstName: "jose", lastName: "diaz" })),
    );
  });
  test("different company domain → different key (same name, different company)", () => {
    expect(dedupKey(mk({ emailDomain: "acme.com" }))).not.toBe(
      dedupKey(mk({ emailDomain: "globex.com" })),
    );
  });
  test("null when name or domain is missing (insufficient signal)", () => {
    expect(dedupKey(mk({ firstName: null, lastName: null }))).toBeNull();
    expect(dedupKey(mk({ emailDomain: null }))).toBeNull();
  });
});

describe("completenessScore", () => {
  test("counts populated enrichable fields", () => {
    expect(completenessScore(mk())).toBe(0);
    expect(
      completenessScore(
        mk({ jobTitle: "VP", linkedinUrl: "x", seniorityLevel: "vp", hasPhone: true }),
      ),
    ).toBe(4);
  });
});

describe("pickCanonical", () => {
  const A = mk({ id: "a", isRevealed: false, jobTitle: "VP", linkedinUrl: "x" }); // score 2, unrevealed
  const B = mk({ id: "b", isRevealed: true }); // score 0, revealed

  test("revealed beats unrevealed even if less complete", () => {
    expect(pickCanonical([A, B]).id).toBe("b");
  });
  test("among same revealed-status, more complete wins", () => {
    const C = mk({ id: "c", isRevealed: false });
    expect(pickCanonical([A, C]).id).toBe("a");
  });
  test("ties break by earliest createdAt, then lowest id (deterministic/idempotent)", () => {
    const early = mk({ id: "z", createdAt: new Date("2025-01-01T00:00:00Z") });
    const late = mk({ id: "a", createdAt: new Date("2026-06-01T00:00:00Z") });
    expect(pickCanonical([late, early]).id).toBe("z"); // earliest wins
    const t1 = mk({ id: "a", createdAt: new Date("2026-01-01T00:00:00Z") });
    const t2 = mk({ id: "b", createdAt: new Date("2026-01-01T00:00:00Z") });
    expect(pickCanonical([t2, t1]).id).toBe("a"); // same time → lowest id
  });
});

describe("computeDuplicateGroups", () => {
  test("a ≥2 same-key group yields one group: canonical + the rest as duplicates", () => {
    const canonical = mk({ id: "rev", isRevealed: true });
    const dup1 = mk({ id: "d1" });
    const dup2 = mk({ id: "d2" });
    const groups = computeDuplicateGroups([dup1, canonical, dup2]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.canonicalId).toBe("rev");
    expect(groups[0]?.duplicateIds.sort()).toEqual(["d1", "d2"]);
  });
  test("singletons, keyless rows, and different-company same-name rows are NOT grouped", () => {
    const solo = mk({ id: "solo", firstName: "Solo", lastName: "Person" });
    const keyless = mk({ id: "keyless", emailDomain: null });
    const acme = mk({ id: "acme1", firstName: "Pat", lastName: "Lee", emailDomain: "acme.com" });
    const globex = mk({ id: "gx1", firstName: "Pat", lastName: "Lee", emailDomain: "globex.com" });
    expect(computeDuplicateGroups([solo, keyless, acme, globex])).toEqual([]);
  });
});
