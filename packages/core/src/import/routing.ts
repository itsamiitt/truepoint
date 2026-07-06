// routing.ts — THE one server-side fast-vs-copy routing decision (import-and-data-model-redesign 08 §1,
// S-I5 pre-gate → S-I9 engagement). The SERVER decides, once, from MEASURED facts (parsed row count + byte
// size) — never a client hint (G10's fix). Pure and env-free (the api passes `env.BULK_IMPORT_THRESHOLD_ROWS`
// in), so the T7 routing matrix is unit-testable and both the one-shot POST and the draft commit consume the
// SAME truth table:
//
//   • within the fast pair (rows ≤ ceiling AND, for CSV, bytes ≤ IMPORT_FASTPATH_MAX_BYTES) ⇒ 'fast' —
//     unchanged regardless of engagement;
//   • CSV over EITHER half + copy ENGAGED (the graduated BULK_IMPORT_ENABLED + bulk_import_enabled pair,
//     evaluated by the api inside the IMPORT_V2 gate — 15 §M-SEQ row 40, no new flag) ⇒ 'copy';
//   • CSV over either half + copy NOT engaged ⇒ the honest ImportTooLargeError refusal NAMING the ceiling —
//     15 §R-P2's standing fallback (copy off per-tenant/fleet ⇒ fast path + honest ceiling), byte-identical
//     to the shipped S-I5 pre-gate;
//   • XLSX over the row ceiling ⇒ `xlsx_too_large` ALWAYS, engaged or not — XLSX cannot be stream-parsed and
//     the copy drive stages CSV only (08 §1's XLSX exception: the honest answer is "export CSV", never a
//     silent buffer-the-world). XLSX bytes are hard-capped at admission (IMPORT_MAX_XLSX_BYTES), so the CSV
//     byte half deliberately skips .xlsx.

import { IMPORT_FASTPATH_MAX_BYTES, ImportTooLargeError } from "@leadwolf/types";

/** The server's routing verdict — the `import_jobs.processing_mode` vocabulary (S-I1 CHECK). */
export type ImportRoutingVerdict = "fast" | "copy";

export interface ImportRoutingFacts {
  /** Untrusted display filename — used ONLY to sniff `.xlsx` (never a path). */
  fileName: string;
  /** Measured upload size in bytes. */
  byteSize: number;
  /** Measured (parsed) data-row count. Callers that short-circuit on the byte half alone may pass 0. */
  rowCount: number;
  /** `env.BULK_IMPORT_THRESHOLD_ROWS` (0/negative = row half disabled — the shipped S-I5 semantics). */
  rowCeiling: number;
  /** S-I9: copy mode ENGAGED for this tenant — env BULK_IMPORT_ENABLED AND the per-tenant
   *  `bulk_import_enabled` flag (the api's `isCopyModeEngaged`, evaluated INSIDE the IMPORT_V2 gate).
   *  false ⇒ over-threshold refuses (the §R-P2 fallback). */
  copyEngaged: boolean;
}

/**
 * Decide the processing mode for one import, or throw the honest RFC-9457 refusal (413) when the file is
 * over-threshold and copy is not an option (not engaged, or XLSX). Never reads env, never queries.
 */
export function decideImportRouting(facts: ImportRoutingFacts): ImportRoutingVerdict {
  const isXlsx = /\.xlsx$/i.test(facts.fileName);
  if (facts.rowCeiling > 0 && facts.rowCount > facts.rowCeiling) {
    if (facts.copyEngaged && !isXlsx) return "copy";
    throw new ImportTooLargeError({
      limit: facts.rowCeiling,
      current: facts.rowCount,
      unit: "rows",
      code: isXlsx ? "xlsx_too_large" : "file_too_large",
    });
  }
  // XLSX bytes are already hard-capped at admission (IMPORT_XLSX_MAX_BYTES); the byte half here is the CSV
  // routing limit (12 §5's 10 MB pair-half).
  if (!isXlsx && facts.byteSize > IMPORT_FASTPATH_MAX_BYTES) {
    if (facts.copyEngaged) return "copy";
    throw new ImportTooLargeError({
      limit: IMPORT_FASTPATH_MAX_BYTES,
      current: facts.byteSize,
      unit: "bytes",
      code: "file_too_large",
    });
  }
  return "fast";
}
