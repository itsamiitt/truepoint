// preview.ts — the pre-commit validation preview (30 §4, ADR-0036 §7; closes G-IMP-1's preview half). Given
// the parsed rows + the confirmed column mapping, it computes the counts the wizard shows BEFORE the user
// confirms the import: how many rows are valid, how many are rejected (with a bounded sample + reasons), and
// a WITHIN-FILE duplicate estimate (rows that collide on a normalized identity key inside the upload itself).
// Pure + synchronous + DB-free (16 §1): against-existing-data dedup is the worker's job — this is the cheap,
// no-commit pass that lets the user catch a bad mapping before a million rows land.

import type { ColumnMapping, ImportPreview, RejectedRow } from "@leadwolf/types";
import type { RawRow } from "./columnMap.ts";
import { identitySignature, rejectedRowsFor, validateRow } from "./validateRow.ts";

/** Default cap on rejected rows sampled into the preview — enough to be useful, bounded so it stays cheap. */
const DEFAULT_SAMPLE_LIMIT = 50;

export interface PreviewOptions {
  /** Max rejected rows to include in `sampleRejectedRows` (default 50). */
  sampleLimit?: number;
}

/**
 * Build the validation preview for `rows` under `mapping`. `total = valid + rejected + duplicate`, where a
 * row counts as `duplicate` only if it is VALID but its identity key already appeared earlier in this file
 * (the first occurrence is `valid`; later collisions are `duplicate`). Rejected rows never count as duplicate.
 */
export function buildImportPreview(
  rows: RawRow[],
  mapping: ColumnMapping,
  options: PreviewOptions = {},
): ImportPreview {
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  let valid = 0;
  let rejected = 0;
  let duplicate = 0;
  const sampleRejectedRows: RejectedRow[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]!;
    const verdict = validateRow(raw, mapping);
    if (!verdict.ok) {
      rejected++;
      if (sampleRejectedRows.length < sampleLimit) {
        sampleRejectedRows.push(...rejectedRowsFor(i, raw, verdict.reasons));
      }
      continue;
    }
    const sig = identitySignature(verdict.identity);
    if (sig && seen.has(sig)) {
      duplicate++;
    } else {
      if (sig) seen.add(sig);
      valid++;
    }
  }

  return { total: rows.length, valid, rejected, duplicate, sampleRejectedRows };
}
