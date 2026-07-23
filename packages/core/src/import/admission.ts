// admission.ts — the upload-admission envelope for the import pipeline (import-redesign 13 §1, step S-S1).
// Everything in an upload is attacker-controlled until it passes this file: the declared Content-Type, the
// extension, the filename, and every byte are all data, never trust (truepoint-security threat mindset).
// Admission is by CONTENT: an .xlsx must present the OOXML ZIP shape; a "CSV" must match no known binary
// magic and decode as text under a detected encoding. The declared type is recorded upstream, never
// load-bearing (13 §1.1). Pure, dependency-free byte-level checks — Node Buffer only, no parser libraries;
// the callers (apps/api routes pre-store, the worker pre-parse) decide WHERE to enforce.

import {
  ArchiveLimitsExceededError,
  IMPORT_MAX_CSV_BYTES,
  IMPORT_MAX_XLSX_BYTES,
  IMPORT_MAX_XLSX_COLS,
  IMPORT_MAX_XLSX_ROWS,
  ImportValidationError,
  UnsupportedMediaTypeError,
} from "@leadwolf/types";

// ── Admission caps. The published-product ceilings (12 §5) now live in the ONE shared source
// `@leadwolf/types/importLimits.ts` (S-P2, TP-7) so admission and the web upload UI consume the SAME number;
// these re-exports keep the local names (parseXlsx / uploadAdmission import them from here) byte-identical
// while centralizing the value. The hardening caps BELOW (multipart / sniff / encoding / zip-bomb) are
// admission-internal SECURITY controls — not published product limits — so they stay local to this file.
/** Max CSV file bytes — 12 §5 launch ceiling (re-exported from the single source). */
export const IMPORT_CSV_MAX_BYTES = IMPORT_MAX_CSV_BYTES;
/** Max XLSX (compressed workbook) bytes — the shipped 25 MiB admission cap (12 §5 drift documented in
 *  importLimits.ts; SHIPPED-CODE-WINS until the S-P4 soak reconciles the published 10 MB). */
export const IMPORT_XLSX_MAX_BYTES = IMPORT_MAX_XLSX_BYTES;
/** Max XLSX data rows (excludes the header). */
export const IMPORT_XLSX_MAX_ROWS = IMPORT_MAX_XLSX_ROWS;
/** Max XLSX header columns. */
export const IMPORT_XLSX_MAX_COLS = IMPORT_MAX_XLSX_COLS;
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
/** Zip-bomb caps (13 §1.4, step S-S5) — enforced at CENTRAL-DIRECTORY read, before any extraction. */
/** 13 §1.4c: entry-count cap (≤ 1,000). A real workbook carries a few dozen parts. */
export const IMPORT_XLSX_MAX_ARCHIVE_ENTRIES = 1_000;
/** 13 §1.4b: expansion-ratio cap (uncompressed/compressed ≤ 100×, config knob). */
export const IMPORT_XLSX_MAX_EXPANSION_RATIO = 100;
/** 13 §1.4a: absolute total-uncompressed cap — 12 §4's ~10× inflation guidance applied to the shipped
 *  25 MiB compressed ceiling (the memory bound; the ratio cap catches small bombs below it). */
export const IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
/** 13 §1.4d: per-entry uncompressed cap (the sheet XML / shared-strings part dominates a real workbook). */
export const IMPORT_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
/** The ratio cap applies only above this uncompressed size — tiny, highly-compressible XML parts of a
 *  LEGITIMATE workbook routinely exceed 100× on a few hundred bytes; the absolute caps bound them anyway. */
export const IMPORT_XLSX_RATIO_ENFORCE_FLOOR_BYTES = 1024 * 1024;
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
    // ignoreBOM:false (the default) strips a leading BOM for the detected encoding. bun-types narrows the
    // decoder label union; "utf-16le"/"utf-16be" are valid WHATWG labels at runtime.
    const decoderLabel = (bom ?? "utf-8") as string as ConstructorParameters<typeof TextDecoder>[0];
    text = new TextDecoder(decoderLabel).decode(bytes);
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
    throw new UnsupportedMediaTypeError("The file is a ZIP archive but not an .xlsx workbook.");
  }
}

// ── S-S5: zip-bomb / archive caps (13 §1.4) ─────────────────────────────────────────────────────────────
// An XLSX IS a zip, with a zip's attack surface. These caps are enforced by reading the CENTRAL DIRECTORY
// only — no entry is ever inflated or extracted here — before SheetJS touches the container. HONEST
// RESIDUAL (recorded): the central directory carries DECLARED sizes; a hostile stream whose deflate output
// exceeds its declaration is bounded only by the compressed-byte ceiling (IMPORT_XLSX_MAX_BYTES) until a
// streaming-inflate cap ships with the scanner era (S-S2). That is 13 §1.4's own placement ("enforced at
// central-directory read"); the declared-size walk is the market control, not a substitute for AV.

const EOCD_SIG = 0x06054b50; // end-of-central-directory record
const CD_SIG = 0x02014b50; // central-directory file header
const EOCD_MIN = 22; // fixed EOCD length (comment excluded)
const ZIP64_U16 = 0xffff;
const ZIP64_U32 = 0xffffffff;

/** Entry names that are archives themselves — rejected outright (13 §1.4e); a real workbook has none. */
const NESTED_ARCHIVE_RE = /\.(zip|jar|war|7z|rar|gz|tgz|bz2|xz|tar|cab|z)$/i;

function corruptArchive(): ImportValidationError {
  return new ImportValidationError(
    "The .xlsx file could not be read — it may be corrupt or not a real .xlsx.",
  );
}

/** An entry name that could escape an extraction root: `..` segments, absolute paths, drive letters,
 *  or backslash separators (OOXML names are always forward-slash relative). Fail closed. */
function isTraversalName(name: string): boolean {
  if (name.startsWith("/") || name.includes("\\") || name.includes(":")) return true;
  return name.split("/").includes("..");
}

/**
 * Enforce the 13 §1.4 decompression-hazard caps on an XLSX container, at central-directory read and before
 * any extraction: (a) total declared uncompressed ≤ IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES; (b) expansion
 * ratio ≤ IMPORT_XLSX_MAX_EXPANSION_RATIO (total and per-entry, above the enforce floor); (c) entry count
 * ≤ IMPORT_XLSX_MAX_ARCHIVE_ENTRIES (and ≥ 1 — the zero-entry edge); (d) per-entry uncompressed ≤
 * IMPORT_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES; (e) no nested archives, no traversal names. ZIP64 markers are
 * rejected outright — a legitimate workbook under our compressed-byte ceiling never needs them.
 * Violations throw `ArchiveLimitsExceededError` (422, stable code `archive_limits_exceeded`, PII-free —
 * reason label + cap numbers only, never an entry name); structural garbage throws the same corrupt-file
 * error the parser uses. Names are decoded latin1 purely for the safety checks and never surface.
 */
export function assertXlsxArchiveWithinLimits(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  if (len < EOCD_MIN) throw corruptArchive();

  // Locate the EOCD record: scan backwards over the maximum comment span (64 KiB + 22).
  let eocd = -1;
  const scanFloor = Math.max(0, len - EOCD_MIN - 0xffff);
  for (let i = len - EOCD_MIN; i >= scanFloor; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw corruptArchive();

  const totalEntries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === ZIP64_U16 || cdSize === ZIP64_U32 || cdOffset === ZIP64_U32) {
    throw new ArchiveLimitsExceededError("zip64");
  }
  if (totalEntries === 0) throw new ArchiveLimitsExceededError("zero_entries");
  if (totalEntries > IMPORT_XLSX_MAX_ARCHIVE_ENTRIES) {
    throw new ArchiveLimitsExceededError("entry_count", {
      maxEntries: IMPORT_XLSX_MAX_ARCHIVE_ENTRIES,
    });
  }
  if (cdOffset + cdSize > len) throw corruptArchive();

  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let walked = 0;

  for (; walked < totalEntries; walked++) {
    if (p + 46 > cdEnd || view.getUint32(p, true) !== CD_SIG) throw corruptArchive();
    const compressed = view.getUint32(p + 20, true);
    const uncompressed = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    if (p + 46 + nameLen > cdEnd) throw corruptArchive();
    if (compressed === ZIP64_U32 || uncompressed === ZIP64_U32) {
      throw new ArchiveLimitsExceededError("zip64");
    }

    const name = buf.toString("latin1", p + 46, p + 46 + nameLen);
    if (NESTED_ARCHIVE_RE.test(name)) throw new ArchiveLimitsExceededError("nested_archive");
    if (isTraversalName(name)) throw new ArchiveLimitsExceededError("path_traversal");

    if (uncompressed > IMPORT_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new ArchiveLimitsExceededError("entry_uncompressed", {
        maxEntryUncompressedBytes: IMPORT_XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES,
      });
    }
    if (
      uncompressed > IMPORT_XLSX_RATIO_ENFORCE_FLOOR_BYTES &&
      uncompressed > Math.max(compressed, 1) * IMPORT_XLSX_MAX_EXPANSION_RATIO
    ) {
      throw new ArchiveLimitsExceededError("expansion_ratio", {
        maxRatio: IMPORT_XLSX_MAX_EXPANSION_RATIO,
      });
    }

    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    if (totalUncompressed > IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES) {
      throw new ArchiveLimitsExceededError("total_uncompressed", {
        maxUncompressedBytes: IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES,
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (
    totalUncompressed > IMPORT_XLSX_RATIO_ENFORCE_FLOOR_BYTES &&
    totalUncompressed > Math.max(totalCompressed, 1) * IMPORT_XLSX_MAX_EXPANSION_RATIO
  ) {
    throw new ArchiveLimitsExceededError("expansion_ratio", {
      maxRatio: IMPORT_XLSX_MAX_EXPANSION_RATIO,
    });
  }
}
