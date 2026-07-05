// parseXlsx.ts — the XLSX adapter for the import pipeline (list-plan/03 §2.1, Phase 2). It turns an uploaded
// .xlsx workbook (raw bytes, never text) into the SAME `{ headers, rows }` contract the CSV path produces, so
// everything downstream — column mapping, validate, normalize, encrypt, blind-index dedup, conflict policy — is
// reused UNCHANGED. Only the parse differs: CSV flows as text, XLSX flows as bytes.
//
// Security (truepoint-security): the workbook is fully untrusted input.
//   • VALUES ONLY — `sheet_to_json` reads the formatted cell value; formulas/macros are never evaluated.
//   • FIRST SHEET ONLY — extra sheets/defined-names/external links are ignored.
//   • ZIP MAGIC — a real .xlsx is an OOXML ZIP; non-ZIP bytes are rejected before parse (SheetJS otherwise
//     mis-reads arbitrary bytes as a 1-cell sheet).
//   • BOUNDED INPUT — the COMPRESSED upload is capped at MAX_BYTES and the parse is capped at MAX_ROWS via
//     `sheetRows`; columns are capped after the header is read. NOTE: `XLSX.read` still decompresses the OOXML
//     container (sheet XML + shared-strings) into memory before `sheetRows` truncates, so the compressed-byte
//     cap — not a decompressed-size cap — is the real ceiling; a hostile high-ratio zip is a known residual to
//     harden at the scale/streaming step (list-plan/03 §6). Over-cap → a clean ImportValidationError, no crash.
//   • CSV-INJECTION — a leading formula trigger (= + - @, incl. after a tab/CR) is neutralized so a value that
//     is later re-exported to a spreadsheet can't execute. This matches the OWASP CSV-injection guidance and is
//     applied at the parse seam so both the preview and the stored raw row are clean.
// Pure + synchronous, mirroring parseFile.ts (16 §1).

import { ImportValidationError } from "@leadwolf/types";
import * as XLSX from "xlsx";
import {
  IMPORT_XLSX_MAX_BYTES as MAX_BYTES,
  IMPORT_XLSX_MAX_COLS as MAX_COLS,
  IMPORT_XLSX_MAX_ROWS as MAX_ROWS,
} from "./admission.ts";
import type { ParsedCsv, RawRow } from "./columnMap.ts";

// Footprint caps (truepoint-security / list-plan/03 §6 "Footprint caps") now live in admission.ts — the ONE
// constants spot for the S-S1 upload envelope (S-P2 will centralize) — and are aliased to the original names.

/** Strip a leading spreadsheet-formula trigger so a re-exported value can't execute (CSV-injection class). */
function neutralizeFormula(value: string): string {
  // A formula trigger may sit behind a leading tab/CR (Excel/Sheets still parse it as a formula).
  return /^[\t\r]*[=+\-@]/.test(value) ? `'${value}` : value;
}

/** Coerce any cell SheetJS hands back (string | number | boolean | Date | undefined) to a trimmed string. */
function cell(value: unknown): string {
  if (value == null) return "";
  const s = value instanceof Date ? value.toISOString() : String(value);
  return neutralizeFormula(s.trim());
}

/**
 * Parse an .xlsx workbook (raw bytes) into `{ headers, rows }`. Reads the FIRST sheet only; row 1 is the
 * header; every cell is coerced to a trimmed string so the result is byte-for-byte the shape `parseCsv`
 * produces. Throws a clean `ImportValidationError` for an empty/corrupt/over-cap workbook.
 */
export function parseXlsx(bytes: Uint8Array): ParsedCsv {
  if (bytes.byteLength === 0) throw new ImportValidationError("The file is empty.");
  if (bytes.byteLength > MAX_BYTES) {
    throw new ImportValidationError(
      `The spreadsheet is too large (max ${MAX_BYTES / (1024 * 1024)} MB). Split it and re-upload.`,
    );
  }
  // A real .xlsx is an OOXML ZIP container — it MUST start with the ZIP local-file-header magic "PK\x03\x04".
  // SheetJS is lenient and will "successfully" mis-read arbitrary bytes as a 1-cell sheet, so we reject any
  // non-ZIP payload up front rather than let a corrupt/spoofed file slip through as an empty import.
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
    throw new ImportValidationError(
      "The .xlsx file could not be read — it may be corrupt or not a real .xlsx.",
    );
  }

  let workbook: XLSX.WorkBook;
  try {
    // type:"array" reads the bytes directly; cellFormula/cellHTML off so we never evaluate or render markup;
    // sheetRows caps the parse to header + MAX_ROWS so an over-tall sheet is bounded at read time.
    workbook = XLSX.read(bytes, {
      type: "array",
      cellFormula: false,
      cellHTML: false,
      sheetRows: MAX_ROWS + 1,
    });
  } catch {
    throw new ImportValidationError(
      "The .xlsx file could not be read — it may be corrupt or password-protected.",
    );
  }

  const firstSheetName = workbook.SheetNames[0];
  const sheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;
  if (!sheet) throw new ImportValidationError("The spreadsheet has no sheets.");

  // header:1 → a matrix (array of rows); raw:false → formatted text; defval:'' → empty cells become "".
  const matrix = (
    XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    }) as unknown[][]
  )
    .map((r) => r.map(cell))
    .filter((r) => r.some((c) => c !== ""));

  if (matrix.length === 0) throw new ImportValidationError("The file is empty.");

  const headers = matrix[0]!.map((h) => h.trim());
  if (headers.length > MAX_COLS) {
    throw new ImportValidationError(`The spreadsheet has too many columns (max ${MAX_COLS}).`);
  }
  const dataRows = matrix.slice(1);
  if (dataRows.length > MAX_ROWS) {
    throw new ImportValidationError(
      `The spreadsheet has too many rows (max ${MAX_ROWS.toLocaleString()}).`,
    );
  }

  const rows: RawRow[] = dataRows.map((cells) => {
    const r: RawRow = {};
    headers.forEach((h, idx) => {
      r[h] = cells[idx] ?? "";
    });
    return r;
  });
  return { headers, rows };
}
