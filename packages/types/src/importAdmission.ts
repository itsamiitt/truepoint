// importAdmission.ts — RFC-9457 error classes for the upload-admission envelope (import-redesign 13 §1,
// steps S-S1/S-S5; slugs from 08 §2.3's verb-table taxonomy). A NEW leaf file (not errors.ts) so the
// concurrent flag/DDL work in this package never collides with the admission slice. Every detail string
// here is PII-free by construction: it names the rule and the cap, never a byte, filename, or cell value.

import { AppError } from "./errors.ts";

/** 08 §2.3 distinguishes the CSV and XLSX byte ceilings by slug (`file_too_large` / `xlsx_too_large`). */
export type FileTooLargeCode = "file_too_large" | "xlsx_too_large";

/**
 * The upload exceeds a published byte ceiling (12 §5) — rejected on `Content-Length` when declared, and
 * again mid-stream at ceiling+1 when the declaration lies (13 §1.2). 413; carries the ceiling as an
 * extension member so the client can render the real limit, per 12 §5 ("published in every rejecting
 * problem response").
 */
export class FileTooLargeError extends AppError {
  constructor(code: FileTooLargeCode, maxBytes: number, detail?: string) {
    super({
      status: 413,
      code,
      title: "File too large",
      detail: detail ?? `The upload exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`,
      extensions: { maxBytes },
    });
  }
}

/**
 * The measured import exceeds a published FAST-PATH ceiling at server-side routing (08 §1 / 12 §5, step S-I5):
 * too many rows, or too many bytes, for the fast lane — and copy mode is not engaged yet (G07+G09 uncleared),
 * so the honest answer is a refusal, not a dead-end toggle. 413 with the 12 §5 stable slug (`file_too_large`
 * by default; `xlsx_too_large` for a spreadsheet). Carries the RFC-9457 quota members `limit` + `current`
 * (+ `unit`) so the client renders the real ceiling and the overage (12 §5: "published in every rejecting
 * problem response"). PII-free by construction — counts and a unit label only.
 */
export class ImportTooLargeError extends AppError {
  constructor(args: {
    limit: number;
    current: number;
    unit: "rows" | "bytes";
    code?: FileTooLargeCode;
    detail?: string;
  }) {
    const asMb = (n: number) => Math.floor(n / (1024 * 1024));
    super({
      status: 413,
      code: args.code ?? "file_too_large",
      title: "Import too large",
      detail:
        args.detail ??
        (args.unit === "rows"
          ? `This import has ${args.current.toLocaleString()} rows — above the ${args.limit.toLocaleString()}-row fast-path limit. Split the file and re-import.`
          : `This upload is ${asMb(args.current)} MB — above the ${asMb(args.limit)} MB fast-path limit. Split the file and re-import.`),
      extensions: { limit: args.limit, current: args.current, unit: args.unit },
    });
  }
}

/**
 * The upload's CONTENT is not an accepted format (13 §1.1: admission is by magic-byte sniffing, never the
 * extension or the declared Content-Type): a "CSV" presenting a known binary magic or NUL bytes, or an
 * ".xlsx" that is not an OOXML ZIP workbook. 415 with 08 §2.3's stable slug.
 */
export class UnsupportedMediaTypeError extends AppError {
  constructor(detail?: string) {
    super({
      status: 415,
      code: "unsupported_media_type",
      title: "Unsupported file type",
      detail,
    });
  }
}

/** The archive-cap rule an XLSX admission failed on (13 §1.4a–e) — a stable label, never an entry name. */
export type ArchiveLimitReason =
  | "expansion_ratio" // uncompressed/compressed above the ratio cap (zip bomb)
  | "total_uncompressed" // declared total uncompressed size above the absolute cap
  | "entry_uncompressed" // one entry's declared uncompressed size above the per-entry cap
  | "entry_count" // more entries than a real workbook could need
  | "zero_entries" // an "archive" with nothing in it (13's zero-entry edge)
  | "nested_archive" // an archive inside the archive
  | "path_traversal" // an entry name escaping the extraction root
  | "zip64"; // ZIP64 markers — legitimate workbooks under our byte caps never need them

/**
 * The XLSX (a ZIP container) violates the decompression-hazard caps (import-redesign 13 §1.4, step S-S5),
 * enforced at central-directory read BEFORE any extraction. 422 with the stable reason code
 * `archive_limits_exceeded`; the extensions carry the rule label and the cap numbers, NEVER an entry name
 * or any file content (PII/injection discipline, 13 §3.3).
 */
export class ArchiveLimitsExceededError extends AppError {
  constructor(reason: ArchiveLimitReason, extensions?: Record<string, unknown>) {
    super({
      status: 422,
      code: "archive_limits_exceeded",
      title: "Spreadsheet archive exceeds safety limits",
      detail:
        "The .xlsx container failed a safety check — rebuild the sheet and re-save it as .xlsx, or upload a CSV.",
      extensions: { reason, ...extensions },
    });
  }
}
