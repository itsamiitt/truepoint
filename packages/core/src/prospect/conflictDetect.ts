// conflictDetect.ts — PURE, IO-free detection of TRUE cross-source field conflicts (data-management #8, the real
// "sources disagree" signal that the multi-source COVERAGE proxy approximated). Given the provenance map a merge is
// about to write (post planFieldWrite), the contact's PRIOR provenance + values, and the incoming values, it marks
// (`cf:true`) each field whose value is being OVERWRITTEN by a DIFFERENT source with a DIFFERENT normalized value.
// Formatting-only differences (case / whitespace) are NOT conflicts. cf is STICKY: a field once flagged stays
// flagged even if a later write agrees. Pure: never mutates inputs; same input → same output (converges on replay).

import type { FieldProvenanceMap } from "@leadwolf/types";

/** Normalize a scalar value for conflict comparison: trim, lowercase, collapse internal whitespace. Null/empty →
 *  null (a missing value on either side is never a conflict — you can't disagree with the absence of a value). */
export function normalizeForConflict(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(/\s+/g, " ");
  return s.length > 0 ? s : null;
}

export interface MarkConflictsInput {
  /** The provenance map the merge is about to write (from planFieldWrite) — each written field's fresh descriptor. */
  provenance: FieldProvenanceMap;
  /** The contact's provenance BEFORE this write (which source last set each field). */
  existingProvenance: FieldProvenanceMap;
  /** The contact's CURRENT scalar values (field → value), before the overwrite. */
  existingValues: Record<string, unknown>;
  /** The incoming scalar values this write brings. */
  incomingValues: Record<string, unknown>;
  /** The fields actually being written (planFieldWrite's writableFields) — pinned fields are excluded. */
  writtenFields: Iterable<string>;
  /** The incoming source label (e.g. "import:apollo"). A field set by this SAME source is never a conflict. */
  incomingSrc: string;
}

/**
 * Return a fresh provenance map with `cf:true` set on every field that TRULY conflicts. A field conflicts when:
 * it is being written, its existing value was set by a DIFFERENT `src`, both the existing and incoming values are
 * present, and their normalized forms DIFFER. Prior conflicts are preserved (sticky). Inputs are never mutated.
 */
export function markConflicts(input: MarkConflictsInput): FieldProvenanceMap {
  const { provenance, existingProvenance, existingValues, incomingValues, writtenFields, incomingSrc } = input;
  const out: FieldProvenanceMap = { ...provenance };
  for (const f of writtenFields) {
    const desc = out[f];
    if (!desc) continue; // only mark fields this write actually stamped
    const prior = existingProvenance[f];
    const stickyConflict = prior?.cf === true;
    const existingSrc = prior?.src;
    const differentSource = existingSrc != null && existingSrc !== incomingSrc;
    const before = normalizeForConflict(existingValues[f]);
    const after = normalizeForConflict(incomingValues[f]);
    const valueConflict = differentSource && before != null && after != null && before !== after;
    if (valueConflict || stickyConflict) out[f] = { ...desc, cf: true };
  }
  return out;
}
