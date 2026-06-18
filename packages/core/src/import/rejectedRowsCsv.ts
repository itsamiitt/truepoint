// rejectedRowsCsv.ts — serialize the rejected-rows artifact (30 §4, ADR-0036 §7; G-IMP-1) to a downloadable
// CSV string: `rowNumber`, `field`, `reason`, then every column of the raw source row echoed back so the
// user can fix-and-re-import only the failures. Pure + synchronous + dependency-free (16 §1) — the web slice
// wraps the returned string in a client-side Blob; the worker can write the same bytes to S3. RFC-4180
// quoting (wrap in quotes + double embedded quotes) keeps embedded commas / newlines / quotes intact.

import type { RejectedRow } from "@leadwolf/types";

/** RFC-4180-quote a single cell: wrap in quotes when it contains a comma, quote, CR or LF; double quotes. */
function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvLine(cells: string[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * Build a CSV from rejected rows. The header is the fixed reason columns followed by the UNION of every raw
 * row's keys (stable order: first-seen). `rowNumber` is 1-based for human readability (the input row number).
 * An empty input yields just the fixed header so a download is never an empty file.
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
