// rejectedRowsCsv.ts — client-side serialization of the rejected-rows artifact (G-IMP-1) into a CSV string
// for download. Mirrors packages/core's rejectedRowsToCsv but lives in the web slice so the browser bundle
// never pulls @leadwolf/core (which reaches node:crypto / @leadwolf/db). Pure string manipulation over the
// RejectedRow[] the import summary already carries; the wizard wraps the result in a Blob + object URL.

import type { RejectedRow } from "@leadwolf/types";

/** RFC-4180-quote a cell: wrap in quotes when it contains a comma, quote, CR or LF; double embedded quotes. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvLine(cells: string[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * Build a CSV from rejected rows: fixed `rowNumber, field, reason` columns + the union of all raw row keys
 * (first-seen order) so the user can fix and re-import only the failures. `rowNumber` is 1-based.
 */
export function rejectedRowsToCsv(rejectedRows: RejectedRow[]): string {
  const rawKeys: string[] = [];
  const seenKey = new Set<string>();
  for (const r of rejectedRows) {
    for (const k of Object.keys(r.raw)) {
      if (!seenKey.has(k)) {
        seenKey.add(k);
        rawKeys.push(k);
      }
    }
  }

  const header = ["rowNumber", "field", "reason", ...rawKeys];
  const lines = [csvLine(header)];
  for (const r of rejectedRows) {
    const rawCells = rawKeys.map((k) => r.raw[k] ?? "");
    lines.push(csvLine([String(r.row + 1), r.field ?? "", r.reason, ...rawCells]));
  }
  return lines.join("\r\n");
}
