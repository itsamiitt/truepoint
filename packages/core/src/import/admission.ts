// admission.ts — the upload-admission envelope for the import pipeline (import-redesign 13 §1, step S-S1).
// Everything in an upload is attacker-controlled until it passes this file: the declared Content-Type, the
// extension, the filename, and every byte are all data, never trust (truepoint-security threat mindset).
// Admission is by CONTENT: an .xlsx must present the OOXML ZIP shape; a "CSV" must match no known binary
// magic and decode as text under a detected encoding. The declared type is recorded upstream, never
// load-bearing (13 §1.1). Pure, dependency-free byte-level checks — Node Buffer only, no parser libraries;
// the callers (apps/api routes pre-store, the worker pre-parse) decide WHERE to enforce.

import { ImportValidationError, UnsupportedMediaTypeError } from "@leadwolf/types";

// ── The ONE local constants spot for admission caps — S-P2 will centralize these as the shared, published
// limit constants (12 §5). Do not scatter or duplicate these numbers; extend this block only.
/** Max CSV file bytes — doc 12 §5's published launch ceiling (250 MB; between Salesforce 150 MB and HubSpot 512 MB). */
export const IMPORT_CSV_MAX_BYTES = 250 * 1024 * 1024;
/** Max XLSX (compressed workbook) bytes. SHIPPED-CODE-WINS drift note: 12 §5 publishes 10 MB for the
 *  fast-path pair, but that pair rides 08 S-I5's server-side routing (not shipped); the shipped parseXlsx
 *  ceiling is 25 MiB and stays authoritative until S-I5/S-P2 reconcile the published number. */
export const IMPORT_XLSX_MAX_BYTES = 25 * 1024 * 1024;
/** Max XLSX data rows (excludes the header) — shipped parseXlsx cap, unchanged by S-S1 (row ceilings ride 08 S-I5). */
export const IMPORT_XLSX_MAX_ROWS = 100_000;
/** Max XLSX header columns — shipped parseXlsx cap, unchanged. */
export const IMPORT_XLSX_MAX_COLS = 256;
/** Whole-request byte ceiling for the import multipart body: the largest admissible file + form overhead
 *  (mapping JSON, policy fields, multipart framing). Enforced on Content-Length AND by counting bytes on
 *  the stream, aborting at ceiling+1 — a lying Content-Length never buffers past the cap (13 §1.2). */
export const IMPORT_UPLOAD_REQUEST_MAX_BYTES = IMPORT_CSV_MAX_BYTES + 1024 * 1024;
/** Multipart hardening (13 §1.5): max parts per import form (today's forms carry ≤ 5). */
export const IMPORT_MULTIPART_MAX_PARTS = 10;
/** Multipart hardening (13 §1.5): max bytes per NON-file text field (the mapping JSON is the largest; 256
 *  columns of long headers sit far below this). */
export const IMPORT_MULTIPART_MAX_FIELD_BYTES = 64 * 1024;
/** Bytes of a CSV stream sniffed at bulk admission (magic/NUL/BOM live in the head of a real text file). */
export const IMPORT_CSV_SNIFF_PREFIX_BYTES = 64 * 1024;
/** Encoding gate (13 §1.3 / 08 §pre-build): undecodable bytes are SYSTEMIC (whole-file 422) when the
 *  U+FFFD replacement count reaches both this floor and 1/RATIO_DENOM of the decoded length; sparse
 *  mojibake below that is tolerated here (the per-row `encoding_suspect` warning surface rides 08 S-I1's
 *  draft flow — the legacy path has no warnings channel; recorded drift). */
export const IMPORT_ENCODING_SUSPECT_MIN = 20;
export const IMPORT_ENCODING_SUSPECT_RATIO_DENOM = 1_000;
// ── end constants block ─────────────────────────────────────────────────────────────────────────────────

/** Known binary magics a "CSV" must NOT present (13 §1.1): ZIP (an XLSX renamed .csv — honest 415, not a
 *  mis-parse), PDF, Windows/ELF executables, OLE2 (legacy .xls), archives, and common image/media magics. */
const BINARY_MAGICS: readonly { magic: readonly number[]; what: string }[] = [
  { magic: [0x50, 0x4b, 0x03, 0x04], what: "a ZIP archive (an .xlsx must keep its .xlsx name)" },
  { magic: [0x50, 0x4b, 0x05, 0x06], what: "a ZIP archive" },
  { magic: [0x50, 0x4b, 0x07, 0x08], what: "a ZIP archive" },
  { magic: [0x25, 0x50, 0x44, 0x46], what: "a PDF" }, // %PDF
  { magic: [0x4d, 0x5a], what: "an executable" }, // MZ
  { magic: [0x7f, 0x45, 0x4c, 0x46], what: "an executable" }, // \x7fELF
  { magic: [0xd0, 0xcf, 0x11, 0xe0], what: "a legacy Office file (save as .csv or .xlsx)" }, // OLE2
  { magic: [0x1f, 0x8b], what: "a gzip archive" },
  { magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], what: "a 7-Zip archive" },
  { magic: [0x52, 0x61, 0x72, 0x21], what: "a RAR archive" }, // Rar!
  { magic: [0x89, 0x50, 0x4e, 0x47], what: "an image" }, // PNG
  { magic: [0xff, 0xd8, 0xff], what: "an image" }, // JPEG
  { magic: [0x47, 0x49, 0x46, 0x38], what: "an image" }, // GIF8
  { magic: [0x52, 0x49, 0x46, 0x46], what: "a media file" }, // RIFF (webp/wav/avi)
];

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[offset + i] !== magic[i]) return false;
  return true;
}

/** The ZIP local-file-header magic every real .xlsx starts with (`PK\x03\x04`). */
export function hasZipMagic(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

/** BOM detection (13 §1.3): returns the encoding the BOM declares, or null when there is no BOM. */
function detectBomEncoding(bytes: Uint8Array): "utf-8" | "utf-16le" | "utf-16be" | null {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return "utf-8";
  if (startsWith(bytes, [0xff, 0xfe])) return "utf-16le";
  if (startsWith(bytes, [0xfe, 0xff])) return "utf-16be";
  return null;
}

/**
 * Content admission for CSV bytes (13 §1.1/§1.3), shared by the full-file and prefix variants: no known
 * binary magic, and no NUL bytes outside a BOM-declared UTF-16 payload ("NUL bytes in a 'CSV' ⇒ treated as
 * binary ⇒ 415"). UTF-16 text is full of NULs by design, so the BOM check runs FIRST. The detail names the
 * detected shape, never the offending bytes (13 §3.3).
 */
function assertCsvBytesAdmissible(bytes: Uint8Array): "utf-8" | "utf-16le" | "utf-16be" | null {
  const bom = detectBomEncoding(bytes);
  if (bom === "utf-16le" || bom === "utf-16be") return bom; // NULs are legitimate UTF-16 code units
  for (const { magic, what } of BINARY_MAGICS) {
    if (startsWith(bytes, magic)) {
      throw new UnsupportedMediaTypeError(
        `The file is not a CSV — its content looks like ${what}.`,
      );
    }
  }
  if (bytes.indexOf(0x00) !== -1) {
    throw new UnsupportedMediaTypeError(
      "The file is not a text CSV — it contains binary (NUL) bytes.",
    );
  }
  return bom;
}

/**
 * Prefix-only CSV sniff for the streaming (bulk) admission path, where the full file is never buffered on
 * the request thread: magic + NUL + BOM checks over the first IMPORT_CSV_SNIFF_PREFIX_BYTES. Returns the
 * BOM-declared encoding (or null for BOM-less/UTF-8) so the caller can refuse encodings its downstream
 * parser cannot decode — the bulk drive parser (`streamParseCsv`) is UTF-8-only, so admitting UTF-16 there
 * would be exactly the silent mojibake 13 §1.3 forbids. The full decode gate for that path runs where the
 * file is actually read (the worker's parse).
 */
export function assertCsvPrefixAdmissible(
  prefix: Uint8Array,
): "utf-8" | "utf-16le" | "utf-16be" | null {
  return assertCsvBytesAdmissible(prefix);
}

/**
 * Full CSV admission + decode (13 §1.3 — encoding handling is a security control, not only UX): sniff for
 * binary content (415), detect the BOM, decode UTF-8 by default or UTF-16 per BOM (the BOM itself is
 * consumed, never leaked into the first header), and reject SYSTEMIC mojibake as a whole-file 422 rather
 * than importing garbage silently. Raw bytes are never echoed into the error (13 §3.3).
 */
export function decodeAdmittedCsv(bytes: Uint8Array): string {
  const bom = assertCsvBytesAdmissible(bytes);
  let text: string;
  try {
    // ignoreBOM:false (the default) strips a leading BOM for the detected encoding.
    text = new TextDecoder(bom ?? "utf-8").decode(bytes);
  } catch {
    // The runtime lacks a decoder for the BOM-declared encoding — refuse honestly, never mojibake.
    throw new ImportValidationError(
      "The file's text encoding is not supported — re-save it as UTF-8 CSV.",
    );
  }
  let replacements = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) replacements++;
  if (
    replacements >= IMPORT_ENCODING_SUSPECT_MIN &&
    replacements * IMPORT_ENCODING_SUSPECT_RATIO_DENOM >= text.length
  ) {
    throw new ImportValidationError(
      "The file could not be decoded as text — re-save it as UTF-8 CSV and re-upload.",
    );
  }
  return text;
}

/**
 * XLSX admission by content (13 §1.1): the bytes must present the ZIP local-file magic AND contain a
 * `[Content_Types].xml` entry naming the workbook parts — a random ZIP renamed .xlsx is refused here with
 * an honest 415 instead of surfacing as a corrupt-parse 422. The name scan is a native Buffer search over
 * the raw bytes (ZIP entry names are stored uncompressed in both the local headers and the central
 * directory, so a real workbook always contains the ASCII string).
 */
export function assertXlsxAdmissible(bytes: Uint8Array): void {
  if (!hasZipMagic(bytes)) {
    throw new UnsupportedMediaTypeError(
      "The file is not a real .xlsx workbook — re-save it as .xlsx or upload a CSV.",
    );
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.indexOf("[Content_Types].xml", 0, "latin1") === -1) {
    throw new UnsupportedMediaTypeError(
      "The file is a ZIP archive but not an .xlsx workbook.",
    );
  }
}
