// parseFile.ts — turn an uploaded file into header-keyed rows for the import pipeline. CSV is parsed here
// with a dependency-free RFC-4180-style reader (handles quoted fields, embedded commas/newlines, and ""
// escapes). XLSX is parsed by the sibling `parseXlsx` adapter (SheetJS) into the SAME { headers, rows }
// contract, so everything downstream is format-agnostic. CSV flows as text; XLSX flows as bytes (16 §1).

import { ImportValidationError } from "@leadwolf/types";
import type { ParsedCsv, RawRow } from "./columnMap.ts";
import { parseXlsx } from "./parseXlsx.ts";

// Re-export the parse-result shape from its leaf home so existing importers (`@leadwolf/core` barrel,
// apps/api, tests) keep importing `ParsedCsv` from here unchanged — while the type itself lives in columnMap.ts
// so parseFile and parseXlsx don't form an import cycle.
export type { ParsedCsv } from "./columnMap.ts";

/** Parse CSV text into a matrix of cells (RFC-4180-ish: quotes, "" escapes, CR/LF, embedded delimiters). */
function parseMatrix(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    sawAny = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (sawAny && (field !== "" || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse CSV text into `{ headers, rows }`; each row is keyed by trimmed header. */
export function parseCsv(text: string): ParsedCsv {
  const matrix = parseMatrix(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (matrix.length === 0) throw new ImportValidationError("The file is empty.");
  const headers = matrix[0]!.map((h) => h.trim());
  const rows: RawRow[] = matrix.slice(1).map((cells) => {
    const r: RawRow = {};
    headers.forEach((h, idx) => {
      r[h] = (cells[idx] ?? "").trim();
    });
    return r;
  });
  return { headers, rows };
}

/** True when the filename names an OOXML workbook (`.xlsx`). Deliberately NOT legacy `.xls` (OLE2/CFB): the
 *  SheetJS adapter (`parseXlsx`) reads the ZIP/OOXML container only, so routing an `.xls` here would reject it
 *  as corrupt. `.xls` users are told to save as `.xlsx` or `.csv` — matching the supported set. */
export function isXlsxFile(filename?: string): boolean {
  return Boolean(filename && /\.xlsx$/i.test(filename));
}

/**
 * Dispatch on file extension to the right parser, returning the SAME `{ headers, rows }` shape regardless of
 * format (list-plan/03 §2.1). CSV flows as TEXT (`file.text()`); XLSX flows as BYTES (`file.arrayBuffer()`).
 * The caller passes a string for CSV and a Uint8Array for XLSX — a type mismatch (text for an .xlsx, or a
 * binary buffer for a .csv) is a clean `ImportValidationError`, never a mis-parse. Everything after the parse
 * (map → validate → normalize → encrypt → dedup → conflict policy) is format-agnostic.
 */
export function parseImportFile(content: string | Uint8Array, filename?: string): ParsedCsv {
  if (isXlsxFile(filename)) {
    if (typeof content === "string") {
      throw new ImportValidationError("An .xlsx file must be read as bytes, not text.");
    }
    return parseXlsx(content);
  }
  // Legacy binary .xls (OLE2/CFB) is not supported — reject it cleanly rather than mis-read its bytes as CSV.
  if (filename && /\.xls$/i.test(filename)) {
    throw new ImportValidationError(
      "Legacy .xls files aren't supported — save the sheet as .xlsx or .csv.",
    );
  }
  if (typeof content !== "string") {
    throw new ImportValidationError("A CSV file must be read as text.");
  }
  return parseCsv(content);
}
