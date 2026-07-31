import { describe, expect, test } from "bun:test";
import { buildConfidenceBadgeV1, strongestMethod } from "./badgeV1.ts";

const NOW = new Date("2026-07-31T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("strongestMethod", () => {
  test("picks the highest prior, not the first or last seen", () => {
    expect(strongestMethod(["crawl", "smtp_verify", "provider"])).toBe("smtp_verify");
    expect(strongestMethod(["pattern_inferred", "crawl"])).toBe("crawl");
  });

  test("an unrecognised method cannot promote itself to the top", () => {
    // A typo or a newly-invented method must not outrank a verified one just by being unknown.
    expect(strongestMethod(["mystery", "provider"])).toBe("provider");
    expect(strongestMethod(["mystery"])).toBeNull();
  });

  test("no methods means no ranking", () => {
    expect(strongestMethod([])).toBeNull();
  });
});

describe("buildConfidenceBadgeV1", () => {
  test("a fresh, well-corroborated verified email scores high", () => {
    const badge = buildConfidenceBadgeV1(
      "email",
      { sourceDiversity: 3, lastObservedAt: daysAgo(2), methods: ["provider", "smtp_verify"] },
      NOW,
    );
    expect(badge?.band).toBe("high");
    expect(badge?.ageDays).toBe(2);
    expect(badge?.sourceCount).toBe(3);
    expect(badge?.strongestMethod).toBe("smtp_verify");
  });

  test("the same evidence years later is no longer high", () => {
    // The entire point of Phase 2: confidence is a function of TIME, not just of how it was obtained.
    const badge = buildConfidenceBadgeV1(
      "email",
      { sourceDiversity: 3, lastObservedAt: daysAgo(1200), methods: ["smtp_verify"] },
      NOW,
    );
    expect(badge?.band).not.toBe("high");
    expect(badge?.confidence).toBeLessThan(0.5);
  });

  test("job title decays faster than country from identical evidence", () => {
    const agg = { sourceDiversity: 1, lastObservedAt: daysAgo(400), methods: ["provider"] };
    const title = buildConfidenceBadgeV1("jobTitle", agg, NOW);
    const country = buildConfidenceBadgeV1("locationCountry", agg, NOW);
    expect(title?.confidence).toBeLessThan(country?.confidence ?? 1);
  });

  test("no evidence returns null rather than a confident-looking zero", () => {
    // Mirrors provenanceBadgeRepository.badgeFor. Until the provenance gate is on this is true of every
    // record, so a rendered zero would stamp a misleading signal across the whole database.
    expect(buildConfidenceBadgeV1("email", null, NOW)).toBeNull();
    expect(
      buildConfidenceBadgeV1("email", { sourceDiversity: 0, lastObservedAt: null, methods: [] }, NOW),
    ).toBeNull();
  });

  test("evidence with no observed date is cold-start, not stale", () => {
    // We know a source asserted it; we do not know when. That is different from knowing it is old.
    const badge = buildConfidenceBadgeV1(
      "email",
      { sourceDiversity: 1, lastObservedAt: null, methods: ["provider"] },
      NOW,
    );
    expect(badge?.ageDays).toBeNull();
    expect(badge?.lastVerifiedAt).toBeNull();
    expect(badge?.confidence).toBeGreaterThan(0.5);
  });

  test("it is a pure function of its inputs — `now` is injected, not read from the clock", () => {
    const agg = { sourceDiversity: 2, lastObservedAt: daysAgo(30), methods: ["provider"] };
    const a = buildConfidenceBadgeV1("email", agg, NOW);
    const b = buildConfidenceBadgeV1("email", agg, NOW);
    expect(a).toEqual(b);
    // …and a later `now` yields a lower score from the SAME aggregate, which is what makes the decay real
    // rather than a value frozen at write time.
    const later = buildConfidenceBadgeV1("email", agg, new Date(NOW.getTime() + 400 * 86_400_000));
    expect(later?.confidence).toBeLessThan(a?.confidence ?? 1);
  });

  test("corroboration raises the score without changing the recency", () => {
    const one = buildConfidenceBadgeV1(
      "email",
      { sourceDiversity: 1, lastObservedAt: daysAgo(60), methods: ["crawl"] },
      NOW,
    );
    const many = buildConfidenceBadgeV1(
      "email",
      { sourceDiversity: 5, lastObservedAt: daysAgo(60), methods: ["crawl"] },
      NOW,
    );
    expect(many?.confidence).toBeGreaterThan(one?.confidence ?? 1);
    expect(many?.ageDays).toBe(one?.ageDays);
  });
});
