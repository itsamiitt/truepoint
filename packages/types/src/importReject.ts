// importReject.ts — the ONE typed reject-code vocabulary for the import pipeline (import-and-data-model-redesign
// 08 §4, 13 §3.3; step S-I7). A single machine-readable code set shared by validateRow (the per-row verdict),
// the `import_job_rows.reject_reason` ledger token, BOTH downloadable artifacts (repair CSV + error report), and
// — as those surfaces land — the preview projection. HubSpot's "50+ typed codes with impact counts" pattern
// (03 §6.1 [5][18]) applied as one closed enum so the ledger, the artifacts, and the future preview can never
// fork the vocabulary.
//
// A NEW LEAF FILE (imports only zod) rather than importV2.ts/importAdmission.ts: `rejectedRowSchema`
// (contacts.ts) references this enum for a typed `code`, and importV2.ts imports contacts.ts — putting the enum
// in importV2.ts would make contacts.ts → importV2.ts a cycle. A leaf keeps contacts.ts importing DOWN, never
// up (the established leaf-file convention this package already uses for importAdmission.ts).
//
// Ledger/artifact discipline (13 §3.3): the token written to `reject_reason` and the `tp__error_code` artifact
// column is `code` or `code:column_ref` — NEVER a cell value. `rejectReasonToken` is the single enforcement
// point; a free-text reason (which may embed a value) is NEVER what lands in the ledger.

import { z } from "zod";

/**
 * The closed reject/anomaly-code vocabulary (08 §4). The first group is written TODAY (validateRow + the fast
 * wrapper's terminal ledger); the reserved group names codes for not-yet-shipped writers (08 §5.3 strategy
 * misses, 06 §5 company ambiguity) and the WARNING band (05 §4 — a warning is counted, the row still lands),
 * declared now so a later writer extends behavior WITHOUT forking the vocabulary or migrating the enum.
 */
export const importRejectCode = z.enum([
  // ── Active rejects (written by validateRow + runFastImport's terminal ledger, S-I7) ──
  "missing_identifier", // no email / LinkedIn / Sales-Nav identity key (whole-row; column ref null)
  "malformed_email", // a mapped "email" value is not a valid address
  "validation_rule_failed", // a staff-authored custom data-quality rule rejected the row (06)
  "processing_error", // a post-validation DB/constraint failure — BUCKETED, never a value (mirrors rejectLabel "Processing error")
  // ── Reserved: strategy / match writers (08 §5.3, 06 §5) — not yet emitted ──
  "no_match_update_only", // update_only mode found no existing contact to update (outcome `skipped`)
  "ambiguous_company_match", // the row's domains resolve to ≥2 accounts — fails loudly to review, never a silent pick
  // ── Reserved: WARNING band (05 §4 / 08 §4) — row LANDS; counted + reported, not a reject ──
  "phone_unparseable", // an unparseable phone (warning; the contact still lands)
  "channel_cap_exceeded", // >25 channel values on one contact (warning; the cap holds, extras dropped)
  "duplicate_header", // two source columns share a header (preview warning; auto-map refuses to guess)
  "encoding_suspect", // undecodable bytes, sparse (per-row warning; systemic ⇒ whole-file 422)
]);
export type ImportRejectCode = z.infer<typeof importRejectCode>;

/** The reserved WARNING codes (05 §4 / 08 §4): a warning is counted + reported but the row still LANDS — it is
 *  never written to a rejected-row ledger entry. Declared so the histogram's warning band and the preview can
 *  distinguish them from true rejects without a second vocabulary. */
export const IMPORT_WARNING_CODES: ReadonlySet<ImportRejectCode> = new Set<ImportRejectCode>([
  "phone_unparseable",
  "channel_cap_exceeded",
  "duplicate_header",
  "encoding_suspect",
]);

/**
 * Build the ledger / artifact reject token (13 §3.3): `code` when the failure is whole-row, `code:column_ref`
 * when it names an offending column. The column ref is a CANONICAL FIELD NAME (e.g. `email`) — non-PII by
 * construction; a cell value is NEVER part of the token. This is the single writer both `reject_reason` and the
 * `tp__error_code` artifact column go through.
 */
export function rejectReasonToken(code: ImportRejectCode, column?: string | null): string {
  return column ? `${code}:${column}` : code;
}
