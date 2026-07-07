// accountBackfill.test.ts — unit tests for S-A3's pure HQ-location decider (planAccountHqBackfill, 15 §2.2).
// No DB: the keyset walk + inserts are the runner's/repo's half. Proven: city carried verbatim; hq_country
// mapped to ISO when confident; a present-but-unmappable hq_country ⇒ country NULL + countryUnmapped=true
// (the location is STILL written — 06 §3 honesty); an absent hq_country is NOT counted as unmapped.

import { describe, expect, test } from "bun:test";
import type { MissingAccountHqRow } from "@leadwolf/db";
import { planAccountHqBackfill } from "./accountBackfill.ts";

const row = (o: Partial<MissingAccountHqRow> = {}): MissingAccountHqRow => ({
  id: "0197a000-0000-7000-8000-000000000001",
  hqCountry: null,
  hqCity: null,
  ...o,
});

describe("planAccountHqBackfill", () => {
  test("mappable country ⇒ ISO alpha-2, city carried, not flagged unmapped", () => {
    const plan = planAccountHqBackfill(row({ hqCountry: "United States", hqCity: "New York" }));
    expect(plan.country).toBe("US");
    expect(plan.city).toBe("New York");
    expect(plan.countryUnmapped).toBe(false);
  });

  test("UNMAPPABLE freetext country ⇒ country NULL + countryUnmapped, but the row is still written (city carried)", () => {
    const plan = planAccountHqBackfill(row({ hqCountry: "Freedonia", hqCity: "Sylvania" }));
    expect(plan.country).toBeNull();
    expect(plan.city).toBe("Sylvania");
    expect(plan.countryUnmapped).toBe(true);
  });

  test("city-only (no hq_country) ⇒ country NULL but NOT counted as unmapped (nothing to map)", () => {
    const plan = planAccountHqBackfill(row({ hqCountry: null, hqCity: "Austin" }));
    expect(plan.country).toBeNull();
    expect(plan.city).toBe("Austin");
    expect(plan.countryUnmapped).toBe(false);
  });

  test("blank hq_country string is treated as nothing-to-map (not unmapped)", () => {
    const plan = planAccountHqBackfill(row({ hqCountry: "   ", hqCity: null }));
    expect(plan.country).toBeNull();
    expect(plan.countryUnmapped).toBe(false);
  });
});
