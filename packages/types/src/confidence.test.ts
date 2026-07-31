import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HALF_LIFE_DAYS,
  FIELD_HALF_LIFE_DAYS,
  computeFieldConfidence,
  confidenceBand,
  corroborationBoost,
  decayFactor,
} from "./confidence.ts";

describe("decayFactor", () => {
  test("halves at exactly one half-life", () => {
    expect(decayFactor(180, 180)).toBeCloseTo(0.5, 6);
    expect(decayFactor(360, 180)).toBeCloseTo(0.25, 6);
    expect(decayFactor(0, 180)).toBe(1);
  });

  test("a negative age cannot boost confidence above the prior", () => {
    // A clock skew or a bad observed_at must not make a value MORE believable than fresh.
    expect(decayFactor(-500, 180)).toBe(1);
  });

  test("a non-positive half-life degrades to no decay rather than dividing by zero", () => {
    expect(decayFactor(100, 0)).toBe(1);
  });
});

describe("corroborationBoost", () => {
  test("one source is no boost", () => {
    expect(corroborationBoost(1)).toBe(1);
    expect(corroborationBoost(0)).toBe(1);
  });

  test("returns diminish — the second source is worth more than the tenth", () => {
    const second = corroborationBoost(2) - corroborationBoost(1);
    const tenth = corroborationBoost(10) - corroborationBoost(9);
    expect(second).toBeGreaterThan(tenth);
  });

  test("capped, so corroboration cannot manufacture certainty", () => {
    // A hundred crawls of the same stale page are still a stale page. A linear boost would walk into that.
    expect(corroborationBoost(1000)).toBeLessThanOrEqual(1.25);
  });
});

describe("computeFieldConfidence", () => {
  test("an SMTP-verified email today is high; the same value years on is not", () => {
    const fresh = computeFieldConfidence({ field: "email", method: "smtp_verify", ageDays: 0 });
    const old = computeFieldConfidence({ field: "email", method: "smtp_verify", ageDays: 1095 });
    expect(fresh).toBeGreaterThan(0.9);
    expect(old).toBeLessThan(0.15);
    expect(confidenceBand(fresh)).toBe("high");
  });

  test("method dominates at equal age — SMTP-verified beats pattern-inferred", () => {
    const verified = computeFieldConfidence({ field: "email", method: "smtp_verify", ageDays: 30 });
    const guessed = computeFieldConfidence({ field: "email", method: "pattern_inferred", ageDays: 30 });
    expect(verified).toBeGreaterThan(guessed * 2);
    // 07 requires an inferred address stay low-confidence until corroborated — this is what stops a guess
    // from reading as fact and producing the first-contact bounce S-08 exists to prevent.
    expect(confidenceBand(guessed)).not.toBe("high");
  });

  test("job title decays faster than country, at the same age and method", () => {
    // The whole point of per-field half-lives: people change roles constantly, countries rarely. This is the
    // S-09 signal, and a single flat SLA cannot express it.
    const title = computeFieldConfidence({ field: "jobTitle", method: "provider", ageDays: 365 });
    const country = computeFieldConfidence({ field: "locationCountry", method: "provider", ageDays: 365 });
    expect(title).toBeLessThan(country);
    expect(FIELD_HALF_LIFE_DAYS.jobTitle).toBeLessThan(FIELD_HALF_LIFE_DAYS.locationCountry);
  });

  test("an unknown field falls back to the default half-life rather than never decaying", () => {
    const known = computeFieldConfidence({ field: "email", method: "provider", ageDays: 270 });
    const unknown = computeFieldConfidence({ field: "somethingNew", method: "provider", ageDays: 270 });
    expect(unknown).toBeCloseTo(known, 6);
    expect(DEFAULT_HALF_LIFE_DAYS).toBe(FIELD_HALF_LIFE_DAYS.email);
  });

  test("an unknown method is provider-grade, never top-grade", () => {
    const unknown = computeFieldConfidence({ field: "email", method: "vibes", ageDays: 0 });
    const best = computeFieldConfidence({ field: "email", method: "smtp_verify", ageDays: 0 });
    expect(unknown).toBeLessThan(best);
  });

  test("cold start returns the undecayed prior, not zero", () => {
    // "We do not know when this was true" is not "this is false". Scoring it 0 would make every legacy
    // record look fabricated the day this ships.
    const cold = computeFieldConfidence({ field: "email", method: "provider", ageDays: null });
    expect(cold).toBeCloseTo(0.75, 6);
  });

  test("a pin floors confidence but does NOT stop it decaying", () => {
    // The human was right when they corrected it — not necessarily today.
    const pinnedFresh = computeFieldConfidence({ field: "jobTitle", method: "crawl", ageDays: 0, pinned: true });
    const pinnedOld = computeFieldConfidence({ field: "jobTitle", method: "crawl", ageDays: 1095, pinned: true });
    expect(pinnedFresh).toBeGreaterThan(0.85);
    expect(pinnedOld).toBeLessThan(pinnedFresh);

    // …and a pin never LOWERS a value that was already stronger.
    const strong = computeFieldConfidence({ field: "email", method: "smtp_verify", ageDays: 0 });
    const strongPinned = computeFieldConfidence({
      field: "email",
      method: "smtp_verify",
      ageDays: 0,
      pinned: true,
    });
    expect(strongPinned).toBeGreaterThanOrEqual(strong);
  });

  test("corroboration lifts a mediocre value without ever exceeding 1", () => {
    const alone = computeFieldConfidence({ field: "email", method: "crawl", ageDays: 30 });
    const corroborated = computeFieldConfidence({
      field: "email",
      method: "crawl",
      ageDays: 30,
      distinctSources: 4,
    });
    expect(corroborated).toBeGreaterThan(alone);
    expect(
      computeFieldConfidence({
        field: "email",
        method: "smtp_verify",
        ageDays: 0,
        distinctSources: 50,
      }),
    ).toBeLessThanOrEqual(1);
  });

  test("the output is always a probability", () => {
    for (const ageDays of [0, 1, 100, 10_000, -5]) {
      for (const method of ["smtp_verify", "pattern_inferred", "nonsense"]) {
        const c = computeFieldConfidence({ field: "email", method, ageDays, distinctSources: 3 });
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("confidenceBand", () => {
  test("bands are ordered and cover the whole range", () => {
    expect(confidenceBand(1)).toBe("high");
    expect(confidenceBand(0.75)).toBe("high");
    expect(confidenceBand(0.74)).toBe("medium");
    expect(confidenceBand(0.5)).toBe("medium");
    expect(confidenceBand(0.49)).toBe("low");
    expect(confidenceBand(0.25)).toBe("low");
    expect(confidenceBand(0.24)).toBe("unverified");
    expect(confidenceBand(0)).toBe("unverified");
  });
});
