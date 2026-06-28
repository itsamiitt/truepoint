// streamParse.ts — a CONSTANT-MEMORY streaming CSV reader for the bulk-import drive path (15-bulk-import-design
// §2/§3, backlog #2). It turns a byte stream (from FileStore.getObjectStream) into header-keyed row objects WITHOUT
// ever holding the whole file in memory: only the current field + the current row are buffered, and each completed
// data row is yielded as soon as its terminating newline arrives. CSV ONLY — XLSX cannot be streamed (SheetJS) and
// stays on the synchronous parseFile path (15 §7).
//
// PARITY IS LOAD-BEARING: a row must parse BYTE-IDENTICALLY whether it goes through the sync path (parseFile.ts
// `parseCsv` → `parseMatrix`) or this streaming path, or a bulk import and a small re-import of the same file would
// disagree. The quoting state machine below MIRRORS `parseMatrix` EXACTLY (RFC-4180-ish: '"' quoting, "" escape,
// ',' delimiter, '\n' row terminator, '\r' ignored). It is DUPLICATED — not shared — because `parseMatrix` is a
// private, whole-string function in parseFile.ts and exporting or refactoring it would change that file (this work
// is additive-only). The one mechanical difference: a `quotePending` flag replaces parseMatrix's `text[i + 1]`
// look-ahead, so a "" escape still resolves correctly when the two quote chars straddle a chunk boundary.

import { ImportValidationError } from "@leadwolf/types";

/**
 * Stream-parse a UTF-8 CSV byte source into header-keyed row objects, in constant memory. The FIRST non-empty row
 * becomes the (trimmed) header; every later non-empty row is yielded as `{ trimmedHeader: trimmedCell }`. Fully
 * empty rows are dropped and extra cells beyond the header count are ignored — identical to parseFile.ts `parseCsv`.
 * A source with no non-empty rows throws `ImportValidationError("The file is empty.")`, mirroring `parseCsv`.
 */
export async function* streamParseCsv(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Record<string, string>> {
  // A streaming decoder so a multi-byte char split across a chunk boundary is reassembled (the final `decode()`
  // with no args flushes any trailing partial byte sequence). Matches the UTF-8 decode the sync path gets from
  // `file.text()`.
  const decoder = new TextDecoder("utf-8");
  let headers: string[] | null = null;
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let quotePending = false;
  let sawAny = false;

  // Drop a fully-empty row, capture the first non-empty row as the header, then key every later row by trimmed
  // header — byte-identical to parseCsv: matrix.filter(r => r.some(c => c.trim() !== "")), headers = row0.map(trim),
  // then r[h] = (cells[idx] ?? "").trim() iterated over the HEADERS (so extra cells are dropped, missing → "").
  const finishRow = (cells: string[]): Record<string, string> | null => {
    if (!cells.some((c) => c.trim() !== "")) return null;
    if (headers === null) {
      headers = cells.map((h) => h.trim());
      return null;
    }
    const out: Record<string, string> = {};
    for (let idx = 0; idx < headers.length; idx++) {
      out[headers[idx]!] = (cells[idx] ?? "").trim();
    }
    return out;
  };

  // The quoting state machine — see the file header: mirrors parseFile.ts `parseMatrix` char-for-char, with
  // `quotePending` standing in for its `text[i + 1]` look-ahead so "" escapes work across chunk boundaries.
  function* consume(text: string): Generator<Record<string, string>> {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      sawAny = true;
      if (quotePending) {
        // The previous char was a '"' while inside quotes — decide now whether it was an escape or the close.
        quotePending = false;
        if (ch === '"') {
          field += '"';
          continue;
        }
        inQuotes = false;
        // not an escape → the quote closed the field; fall through to process `ch` in unquoted mode.
      }
      if (inQuotes) {
        if (ch === '"') quotePending = true;
        else field += ch;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        continue;
      }
      if (ch === ",") {
        row.push(field);
        field = "";
        continue;
      }
      if (ch === "\n") {
        row.push(field);
        const ready = finishRow(row);
        if (ready) yield ready;
        row = [];
        field = "";
        continue;
      }
      if (ch !== "\r") field += ch;
    }
  }

  for await (const chunk of source) {
    yield* consume(decoder.decode(chunk, { stream: true }));
  }
  // Flush any bytes the streaming decoder is still holding (a multi-byte char at the very end of the stream).
  yield* consume(decoder.decode());

  // EOF tail — mirror parseMatrix: a pending field/row (a file with no trailing newline) becomes one last row.
  // Same guard: only when the input had content AND there is a partial field or a started row to emit.
  if (sawAny && (field !== "" || row.length > 0)) {
    row.push(field);
    const ready = finishRow(row);
    if (ready) yield ready;
  }

  // Mirror parseCsv's empty-file guard: no non-empty row was ever seen (matrix.length === 0) → the same error.
  if (headers === null) {
    throw new ImportValidationError("The file is empty.");
  }
}
