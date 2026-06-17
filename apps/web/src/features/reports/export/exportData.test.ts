// exportData.test.ts — pins the report export dataset builders (the single source of truth that CSV + XLSX
// share). Asserts each dashboard's headers and rows are derived faithfully from its rollup, every row matches
// the header arity, the filename carries the local date stamp, and the data is PII-free (only labels +
// aggregate numbers from the rollups — never raw contact fields). Pure: builders take rollup view-models in.

import { describe, expect, it } from "bun:test";
import type { CreditRollup, DataHealthRollup, FunnelRollup, TeamRollup } from "../types";
import {
  type ReportDataset,
  creditUsageDataset,
  dataHealthDataset,
  funnelDataset,
  teamDataset,
} from "./exportData";

const NOW = new Date("2026-06-17T12:00:00Z");

/** Every row must have exactly as many cells as there are headers — no ragged tables reach a download. */
function expectRectangular(ds: ReportDataset): void {
  for (const row of ds.rows) expect(row.length).toBe(ds.headers.length);
}

describe("creditUsageDataset", () => {
  const rollup: CreditRollup = {
    revealsLast7: 5,
    creditsLast7: 12,
    days: [
      { key: "2026-06-16", label: "Jun 16", reveals: 2, credits: 4 },
      { key: "2026-06-17", label: "Jun 17", reveals: 3, credits: 8 },
    ],
    maxCredits: 8,
    byType: [{ revealType: "email", label: "Email", reveals: 5, credits: 12 }],
    hasSpend: true,
  };

  it("builds a section/item/reveals/credits sheet over by-type then by-day", () => {
    const ds = creditUsageDataset(rollup, NOW);
    expect(ds.headers).toEqual(["Section", "Item", "Reveals", "Credits"]);
    expect(ds.rows[0]).toEqual(["By reveal type", "Email", 5, 12]);
    expect(ds.rows[1]).toEqual(["By day", "Jun 16", 2, 4]);
    expect(ds.rows).toHaveLength(rollup.byType.length + rollup.days.length);
    expect(ds.filename).toBe("credit-usage-2026-06-17");
    expectRectangular(ds);
  });
});

describe("funnelDataset", () => {
  const rollup: FunnelRollup = {
    primary: [
      { status: "new", label: "New", count: 10, conversionPct: 100 },
      { status: "replied", label: "Replied", count: 4, conversionPct: 40 },
    ],
    secondary: [{ status: "nurture", label: "Nurture", count: 2, conversionPct: 0 }],
    total: 16,
    maxCount: 10,
  };

  it("emits journey rows with conversion and off-ramp rows without it", () => {
    const ds = funnelDataset(rollup, NOW);
    expect(ds.headers).toEqual(["Group", "Stage", "Contacts", "Conversion %"]);
    expect(ds.rows[0]).toEqual(["Journey", "New", 10, 100]);
    expect(ds.rows.at(-1)).toEqual(["Out of funnel", "Nurture", 2, ""]);
    expect(ds.rows).toHaveLength(3);
    expectRectangular(ds);
  });
});

describe("dataHealthDataset", () => {
  const rollup: DataHealthRollup = {
    rows: [
      { status: "valid", label: "Valid", tone: "success", count: 8, pct: 80 },
      { status: "invalid", label: "Invalid", tone: "danger", count: 2, pct: 20 },
    ],
    valid: 8,
    withEmail: 10,
    unverified: 0,
    total: 10,
  };

  it("builds an email-status/contacts/share sheet", () => {
    const ds = dataHealthDataset(rollup, NOW);
    expect(ds.headers).toEqual(["Email status", "Contacts", "Share %"]);
    expect(ds.rows).toEqual([
      ["Valid", 8, 80],
      ["Invalid", 2, 20],
    ]);
    expectRectangular(ds);
  });
});

describe("teamDataset", () => {
  const rollup: TeamRollup = {
    rows: [{ userId: "u-1", label: "Member ABCD", revealed: 7, credits: 14, engaged: 3 }],
    members: 1,
    totalRevealed: 7,
  };

  it("builds a member/revealed/engaged/credits sheet from privacy-safe labels (no raw user id leaks)", () => {
    const ds = teamDataset(rollup, NOW);
    expect(ds.headers).toEqual(["Member", "Revealed", "Engaged", "Credits"]);
    expect(ds.rows[0]).toEqual(["Member ABCD", 7, 3, 14]);
    // The raw owner id must never reach the export — only the masked label.
    expect(JSON.stringify(ds.rows)).not.toContain("u-1");
    expectRectangular(ds);
  });
});
