// artifactWriter.ts — the ONE server-side import artifact writer (import-and-data-model-redesign 08 §6.2,
// step S-I7; the market-topping pair — 03 §1.1 [5], §6.1 [58]). At a fast import's terminal transition, when
// ≥1 row was rejected, it generates the downloadable PAIR and writes them through the FileStore seam under the
// job's key prefix:
//
//   • Repair CSV   — the user's ORIGINAL columns echoed, one line per rejected INPUT ROW, plus appended
//                    `tp__error_code` (the typed code:column token, importReject.ts) and `tp__error_detail`
//                    (the human reason — legal here, 13 §3.3, because the repair CSV already carries the full
//                    row under §4's gate). Fix-and-reimport feeds retry directly (08 §6.3).
//   • Error report — TAXONOMY-GROUPED aggregate: error code · column · impact count · sample line numbers.
//                    Triage 50k rows without opening them (03 §6.1 [5]). NO raw values (13 §3.3) — the
//                    `_REDACTED_` pass on any value fragment lands with the neutralizer in S-S3.
//
// It is the promotion of the shipped `rejectedRowsCsv.ts` generator to a SERVER-SIDE pair (that predecessor is
// the legacy single-artifact, retiring with the legacy surface — 13 §4.2). Pure builders (dependency-free, 16
// §1) so a unit test asserts the exact bytes; the async writer is best-effort per artifact (a store failure
// leaves the key unset and the job honestly artifact-less, mirroring runBulkImport's posture).
//
// FORMULA-INJECTION NEUTRALIZATION (S-S3, 13 §4.5): every cell of BOTH artifacts whose first character is
// `=`/`+`/`-`/`@` (or a tab/CR/LF-led variant) is prefixed with a single quote — the OWASP CSV-injection
// convention — so a hostile cell (`=WEBSERVICE(...)`, `=cmd|...`) uploaded in someone's CSV cannot execute on
// the desk of the admin who opens the repair file (the repair-CSV half of 13 §11 worst-case #1). Applied to the
// echoed ORIGINAL columns too — "echo byte-faithfully" (08 §6.2) is amended to "byte-faithful EXCEPT the
// leading-quote neutralization" (documented, doc 11 owns the UI note). Parse-side strip on repair-CSV re-import
// (the round-trip half of T-S1) rides the retry-reimport path (S-I10), which does not exist yet.
//
// The error report additionally runs the `_REDACTED_` pass (13 §3.3, HubSpot 03 §6.1 [5][18]) on its detail
// column: value fragments (email-like / long-digit runs) are replaced with `_REDACTED_`. The report's blast
// radius (small, shareable file) invites forwarding, so — unlike the repair CSV, which already carries the full
// row under §4's gate — it must never surface a value.
//
// ENCRYPTION-AT-REST: artifacts inherit 08 §8 Gate A's SSE-KMS requirement, delivered by the production S3
// adapter (G07 / Phase 2). The dev `diskFileStore` is PLAINTEXT local disk (no signing, no encryption) — the
// honest gap 13 acknowledges; artifacts are only ever generated while the dual gate is on, which in prod means
// after G07's encrypting adapter lands. Recorded here so the gap is never silently assumed closed.

import { type RejectedRow, rejectReasonToken } from "@leadwolf/types";
import type { FileStore } from "../storage/fileStore.ts";

/** The appended repair-CSV columns (the Salesforce `sf__Error` convention, 03 §6.1 [58]). `tp__` namespaced so
 *  a re-import ignores them (they collide with no canonical field / custom-field key). */
const REPAIR_CODE_COLUMN = "tp__error_code";
const REPAIR_DETAIL_COLUMN = "tp__error_detail";
/** Cap the sample line numbers per taxonomy bucket in the error report — a triage aid, not a full list. */
const ERROR_REPORT_SAMPLE_LINES = 20;

/** CSV formula-injection neutralizer (13 §4.5, OWASP): prefix a single quote when the cell's FIRST character is
 *  a formula trigger (`=`,`+`,`-`,`@`) or a control char a spreadsheet strips before evaluating (TAB/CR/LF) —
 *  so `\t=cmd` (tab-led) is caught as well as `=cmd`. Display-safe (`-42`, `+1-555…` open showing a leading
 *  quote in the cell); the round-trip strip on re-import rides S-I10. Empty string is left untouched. */
export function neutralizeCell(value: string): string {
  if (value.length > 0 && /^[=+\-@\t\r\n]/.test(value)) return `'${value}`;
  return value;
}

/** Replace value fragments (email-like tokens, 7+-digit runs) with `_REDACTED_` — the error-report scrubber
 *  (13 §3.3) so a taxonomy detail can never leak a cell value. Codes/columns/counts are untouched (no `@`, no
 *  long digit runs). Conservative by design: it errs toward redacting, never toward exposing. */
export function redactValues(text: string): string {
  return text
    .replace(/[^\s,@"']+@[^\s,@"']+\.[^\s,@"']+/g, "_REDACTED_") // email-like
    .replace(/\d{7,}/g, "_REDACTED_"); // phone/id-like digit runs
}

/** RFC-4180-quote a single cell: wrap in quotes when it contains a comma, quote, CR or LF; double quotes. */
function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Neutralize (formula-injection) THEN RFC-4180-quote every cell — the order matters: the leading quote is added
 *  before the field is wrapped, so a neutralized value survives the round-trip intact. */
function csvLine(cells: string[]): string {
  return cells.map((v) => csvCell(neutralizeCell(v))).join(",");
}

/** The deterministic object-store keys for a job's artifacts, under its `imports/<jobId>/` prefix (the same
 *  prefix the source upload uses — 08 §6.2 "under the job's key prefix"). The `:kind` route param maps to these. */
export function repairArtifactKey(jobId: string): string {
  return `imports/${jobId}/repair.csv`;
}
export function errorReportArtifactKey(jobId: string): string {
  return `imports/${jobId}/errors.csv`;
}

/**
 * Collapse the reject list to one entry per input LINE, keeping the FIRST (primary) reason — the exact rule the
 * fast wrapper's ledger uses (runFastImport), so the repair CSV and the `import_job_rows` ledger describe the
 * same rows with the same primary code. A row with several field reasons appears once, annotated by its primary.
 */
function primaryByRow(rejectedRows: RejectedRow[]): RejectedRow[] {
  const byRow = new Map<number, RejectedRow>();
  for (const r of rejectedRows) if (!byRow.has(r.row)) byRow.set(r.row, r);
  return [...byRow.values()];
}

/**
 * Build the repair CSV: the union of every rejected row's original columns (stable first-seen order), then the
 * appended `tp__error_code` + `tp__error_detail`. One line per rejected INPUT ROW (primary reason). Empty input
 * yields just the header so a download is never an empty file (rejected>0 is the caller's precondition anyway).
 */
export function buildRepairCsv(rejectedRows: RejectedRow[]): string {
  const rows = primaryByRow(rejectedRows);
  const rawKeys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.raw)) {
      if (!seen.has(k)) {
        seen.add(k);
        rawKeys.push(k);
      }
    }
  }
  const header = [...rawKeys, REPAIR_CODE_COLUMN, REPAIR_DETAIL_COLUMN];
  const lines = [csvLine(header)];
  for (const r of rows) {
    const rawCells = rawKeys.map((k) => r.raw[k] ?? "");
    // tp__error_code = the typed code:column token (never a value); tp__error_detail = the human reason.
    const code = r.code ? rejectReasonToken(r.code, r.field) : (r.field ?? "");
    lines.push(csvLine([...rawCells, code, r.reason]));
  }
  return lines.join("\r\n");
}

/**
 * Build the taxonomy-grouped error report: one row per `code:column` bucket with an impact count + a capped list
 * of 1-based sample line numbers. Aggregates over EVERY reason (a row with two field reasons lands in two
 * buckets — correct "rows affected by this code"). Columns are codes / column refs / counts / line numbers only —
 * NO cell values (13 §3.3); the `_REDACTED_` pass on any value fragment is S-S3.
 */
export function buildErrorReportCsv(rejectedRows: RejectedRow[]): string {
  interface Bucket {
    code: string;
    column: string;
    count: number;
    lines: number[];
    detail: string; // the first occurrence's reason, REDACTED (never a raw value)
  }
  const buckets = new Map<string, Bucket>();
  for (const r of rejectedRows) {
    const code = r.code ?? "processing_error";
    const key = rejectReasonToken(code, r.field);
    let b = buckets.get(key);
    if (!b) {
      // The detail is the FIRST reason for this bucket, value-scrubbed to `_REDACTED_` — a triage hint, never a
      // cell value (13 §3.3). Generic reasons ("Malformed email address.") survive verbatim; a processing_error
      // that quoted a value comes through redacted.
      b = { code, column: r.field ?? "", count: 0, lines: [], detail: redactValues(r.reason) };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.lines.length < ERROR_REPORT_SAMPLE_LINES) b.lines.push(r.row + 1); // 1-based for humans
  }
  const header = ["error_code", "column", "impact_count", "sample_lines", "sample_detail"];
  const lines = [csvLine(header)];
  for (const b of buckets.values()) {
    lines.push(csvLine([b.code, b.column, String(b.count), b.lines.join(" "), b.detail]));
  }
  return lines.join("\r\n");
}

/** The keys written for a job's artifact pair (null = the store write failed or was skipped — the job is then
 *  honestly artifact-less for that kind). */
export interface ImportArtifactKeys {
  repairKey: string | null;
  errorsKey: string | null;
}

/**
 * Generate the pair and write both through the FileStore under the job's prefix. Best-effort PER ARTIFACT: a
 * store failure logs and leaves that key null (the terminal tx then records no key for it — the UI shows
 * "expired/unavailable" honestly rather than a dead link). Object-store I/O — call OUTSIDE the terminal DB tx so
 * a slow put never holds a transaction open; the returned keys ride the tx.
 */
export async function writeImportArtifacts(
  fileStore: FileStore,
  jobId: string,
  rejectedRows: RejectedRow[],
): Promise<ImportArtifactKeys> {
  const keys: ImportArtifactKeys = { repairKey: null, errorsKey: null };
  try {
    const repairKey = repairArtifactKey(jobId);
    await fileStore.putArtifact(repairKey, Buffer.from(buildRepairCsv(rejectedRows), "utf8"));
    keys.repairKey = repairKey;
  } catch (err) {
    console.error("[import] failed to write repair-CSV artifact", err);
  }
  try {
    const errorsKey = errorReportArtifactKey(jobId);
    await fileStore.putArtifact(errorsKey, Buffer.from(buildErrorReportCsv(rejectedRows), "utf8"));
    keys.errorsKey = errorsKey;
  } catch (err) {
    console.error("[import] failed to write error-report artifact", err);
  }
  return keys;
}
