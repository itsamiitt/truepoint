// parseFile.ts — turn an uploaded file into header-keyed rows for the import pipeline. CSV is parsed here
// with a dependency-free RFC-4180-style reader (handles quoted fields, embedded commas/newlines, and ""
// escapes). XLSX is a declared seam for M1 — it throws a clear ImportValidationError until the `xlsx`
// adapter lands, rather than silently mis-parsing a binary file. Pure + synchronous (16 §1).

import { ImportValidationError } from "@leadwolf/types";
import type { RawRow } from "./columnMap.ts";

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

export interface ParsedCsv {
  headers: string[];
  rows: RawRow[];
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

/** Dispatch on file extension. CSV is parsed; XLSX is a declared seam (throws) until the adapter lands. */
export function parseImportFile(content: string, filename?: string): ParsedCsv {
  if (filename && /\.xlsx?$/i.test(filename) && !/\.csv$/i.test(filename)) {
    throw new ImportValidationError("XLSX import is not supported yet — export the sheet as CSV.");
  }
  return parseCsv(content);
}
