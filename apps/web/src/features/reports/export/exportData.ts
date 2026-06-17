// exportData.ts — the single source of truth for what each report exports. Every dashboard's export dataset is
// built here ONCE as { filename, sheetName, headers, rows } so CSV (downloadCsv) and XLSX (downloadXlsx) emit
// byte-identical columns + values — no drift between the two formats. The rows come straight from the already
// PII-free, workspace-scoped rollups (rollups.ts), so nothing raw can leak through an export. Pure: no DOM, no
// fetch, no React — directly unit-testable.

import type { CreditRollup, DataHealthRollup, FunnelRollup, TeamRollup } from "../types";
import type { XlsxCell } from "./xlsxWriter";

/** A flat, format-agnostic export table. The same shape feeds the CSV escaper and the XLSX writer. */
export interface ReportDataset {
  /** Base filename WITHOUT extension (the format adds .csv / .xlsx). */
  filename: string;
  /** XLSX worksheet tab name. */
  sheetName: string;
  headers: string[];
  rows: XlsxCell[][];
}

/** ISO yyyy-mm-dd date stamp for the filename (local date — matches what the user sees on the page). */
function stamp(now: Date): string {
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Credit usage → spend by reveal type, plus the 14-day per-day spend, in one sheet. */
export function creditUsageDataset(rollup: CreditRollup, now = new Date()): ReportDataset {
  const byType: XlsxCell[][] = rollup.byType.map((r) => [
    "By reveal type",
    r.label,
    r.reveals,
    r.credits,
  ]);
  const byDay: XlsxCell[][] = rollup.days.map((d) => ["By day", d.label, d.reveals, d.credits]);
  return {
    filename: `credit-usage-${stamp(now)}`,
    sheetName: "Credit usage",
    headers: ["Section", "Item", "Reveals", "Credits"],
    rows: [...byType, ...byDay],
  };
}

/** Pipeline funnel → every stage (journey + off-ramps) with its count and conversion %. */
export function funnelDataset(rollup: FunnelRollup, now = new Date()): ReportDataset {
  const rows: XlsxCell[][] = [
    ...rollup.primary.map((s): XlsxCell[] => ["Journey", s.label, s.count, s.conversionPct]),
    ...rollup.secondary.map((s): XlsxCell[] => ["Out of funnel", s.label, s.count, ""]),
  ];
  return {
    filename: `pipeline-funnel-${stamp(now)}`,
    sheetName: "Pipeline funnel",
    headers: ["Group", "Stage", "Contacts", "Conversion %"],
    rows,
  };
}

/** Data health → per email-verification-status counts + share. */
export function dataHealthDataset(rollup: DataHealthRollup, now = new Date()): ReportDataset {
  return {
    filename: `data-health-${stamp(now)}`,
    sheetName: "Data health",
    headers: ["Email status", "Contacts", "Share %"],
    rows: rollup.rows.map((r) => [r.label, r.count, r.pct]),
  };
}

/** Team activity → per-member revealed / engaged / credits. */
export function teamDataset(rollup: TeamRollup, now = new Date()): ReportDataset {
  return {
    filename: `team-activity-${stamp(now)}`,
    sheetName: "Team activity",
    headers: ["Member", "Revealed", "Engaged", "Credits"],
    rows: rollup.rows.map((r) => [r.label, r.revealed, r.engaged, r.credits]),
  };
}
