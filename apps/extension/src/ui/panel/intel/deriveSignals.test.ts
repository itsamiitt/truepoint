// deriveSignals.test.ts — the panel's honesty guarantee, pinned.
//
// The load-bearing test here is #7: EVERY signal must carry a field, a basis and a grade. That is what makes
// the list a restatement of the record rather than an opinion about it, and it is the property a future rule
// is most likely to quietly drop.
//
// Fabricated fixtures only — the vendor samples in `source plan/` are third-party PII and never become
// test data.

import { describe, expect, it } from "bun:test";
import type { ProfileIntelResponse } from "@leadwolf/types";
import { deriveSignals } from "./deriveSignals.ts";

const NOW = new Date("2026-08-22T00:00:00.000Z");

function intel(over: Partial<ProfileIntelResponse> = {}): ProfileIntelResponse {
  return {
    kind: "person",
    status: "found",
    contactId: "c-1",
    owned: false,
    person: null,
    contact: null,
    profile: null,
    company: null,
    signals: [],
    ...over,
  };
}

function stint(over: Record<string, unknown> = {}) {
  return {
    companyName: "Acme Inc",
    companyDomain: "acme.example",
    title: "Head of Finance",
    location: null,
    isCurrent: true,
    isPrimary: true,
    startedOn: "2024-06-01",
    endedOn: null,
    startPrecision: "month",
    endPrecision: null,
    ...over,
  };
}

function profile(employment: ReturnType<typeof stint>[]) {
  return { employment, education: [], skills: [], languages: [], hasMobile: false };
}

function company(series: number[], over: Record<string, unknown> = {}) {
  return {
    company: {
      primaryDomain: "acme.example",
      name: "Acme Inc",
      revenueDisplay: null,
      employeeCount: series.at(-1) ?? null,
      ...over,
    },
    locations: [],
    headcountSeries: series.map((employeeCount, i) => ({
      month: `2024-${String((i % 12) + 1).padStart(2, "0")}-01`,
      employeeCount,
    })),
  } as unknown as NonNullable<ProfileIntelResponse["company"]>;
}

describe("deriveSignals", () => {
  it("1. reports time in seat, and which side of the first-90-days window it falls on", () => {
    const settled = deriveSignals(
      intel({ profile: profile([stint({ startedOn: "2024-06-01" })]) as never }),
      NOW,
    );
    const tenure = settled.find((s) => s.id === "role_tenure");
    expect(tenure?.kind).toBe("people");
    expect(tenure?.field).toBe("employment.started_on");
    expect(tenure?.grade).toBe("past the first-90-days window");

    const fresh = deriveSignals(
      intel({ profile: profile([stint({ startedOn: "2026-07-01" })]) as never }),
      NOW,
    );
    expect(fresh.find((s) => s.id === "role_tenure")?.grade).toBe(
      "inside the first-90-days window",
    );
  });

  it("2. emits NO tenure signal from a year-precision start", () => {
    // "2018" spans twelve months of possible answers; a first-90-days claim built on it would be invented.
    const s = deriveSignals(
      intel({
        profile: profile([stint({ startedOn: "2018-01-01", startPrecision: "year" })]) as never,
      }),
      NOW,
    );
    expect(s.find((x) => x.id === "role_tenure")).toBeUndefined();
  });

  it("3. surfaces a server job_change and never invents one", () => {
    const withSignal = deriveSignals(
      intel({ signals: [{ signal_type: "job_change", weight: 5, detected_at: "2026-08-01" }] }),
      NOW,
    );
    expect(withSignal.some((s) => s.id.startsWith("job_change:"))).toBe(true);

    // The signal_type enum admits nine values but only job_change has a producer. An unknown type must not
    // become a row — that would advertise coverage the product does not have.
    const other = deriveSignals(
      intel({ signals: [{ signal_type: "tech_install", weight: 3, detected_at: "2026-08-01" }] }),
      NOW,
    );
    expect(other).toHaveLength(0);
  });

  it("4. reads growth and decline off the series, and flags a flat month as weak", () => {
    const growth = deriveSignals(
      intel({ company: company([71, 80, 90, 100, 120, 140, 160, 180, 190, 200, 205, 209, 209]) }),
      NOW,
    );
    const up = growth.find((s) => s.id === "headcount_growth_12m");
    expect(up?.kind).toBe("growth");
    expect(up?.basis).toBe("71 → 209 employees");

    // One month is one data point, and the row says exactly that.
    expect(growth.find((s) => s.id === "growth_paused")?.grade).toBe(
      "single-month reading, treat as weak",
    );

    const decline = deriveSignals(
      intel({ company: company([200, 190, 180, 170, 160, 150, 140, 130, 125, 120, 115, 110, 100]) }),
      NOW,
    );
    // A decline is a caution, not a "growth" row with a minus sign.
    expect(decline.find((s) => s.id === "headcount_decline_12m")?.kind).toBe("caution");
  });

  it("5. flags a revenue band the headcount has outgrown", () => {
    const s = deriveSignals(
      intel({
        company: company([24, 60, 120, 209], { revenueDisplay: "$1M–$2.5M", employeeCount: 209 }),
      }),
      NOW,
    );
    const stale = s.find((x) => x.id === "revenue_band_stale");
    expect(stale?.kind).toBe("data quality");
    expect(stale?.grade).toBe("stale field — do not quote");
    expect(stale?.field).toBe("revenue_range");
  });

  it("6. reports unverified email and absent phone as data-quality facts", () => {
    const s = deriveSignals(
      intel({
        contact: {
          hasEmail: true,
          hasPhone: false,
          emailStatus: "unverified",
        } as never,
      }),
      NOW,
    );
    expect(s.find((x) => x.id === "email_unverified")?.grade).toBe(
      "unverified — bounce risk on first contact",
    );
    // "No phone on record" is an absence of a value, not a failed lookup — the row says which.
    expect(s.find((x) => x.id === "no_phone")?.grade).toBe(
      "absence of a value, not a failed lookup",
    );

    // A verified email is not a signal — only what a rep should treat carefully earns a row.
    const verified = deriveSignals(
      intel({ contact: { hasEmail: true, hasPhone: true, emailStatus: "valid" } as never }),
      NOW,
    );
    expect(verified).toHaveLength(0);
  });

  it("7. every signal cites a field, a basis and a grade (the A-01 property)", () => {
    const s = deriveSignals(
      intel({
        profile: profile([stint()]) as never,
        company: company([71, 80, 90, 100, 120, 140, 160, 180, 190, 200, 205, 209, 209], {
          revenueDisplay: "$1M–$2.5M",
          employeeCount: 209,
        }),
        contact: { hasEmail: true, hasPhone: false, emailStatus: "unverified" } as never,
        signals: [{ signal_type: "job_change", weight: 5, detected_at: "2026-08-01" }],
      }),
      NOW,
    );
    expect(s.length).toBeGreaterThan(4);
    for (const row of s) {
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.field.length).toBeGreaterThan(0);
      expect(row.basis.length).toBeGreaterThan(0);
      expect(row.grade.length).toBeGreaterThan(0);
    }
    // Rendered people → growth → caution → data quality, so the person comes before the caveats.
    const order = ["people", "growth", "caution", "data quality"];
    const idx = s.map((r) => order.indexOf(r.kind));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it("8. an empty record produces an empty list, not a placeholder row", () => {
    expect(deriveSignals(intel(), NOW)).toEqual([]);
  });
});
