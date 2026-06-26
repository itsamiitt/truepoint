// fieldProvenance.ts — PURE, IO-free helpers for the overlay field-provenance merge (PLAN_03 §1.4 overlay pin /
// §3.1 descriptor). These plan a write against an EXISTING overlay `field_provenance` map: they decide which
// fields may be written and what each descriptor becomes — the caller persists the result inside its own
// RLS-scoped tenant tx (no DB here). The load-bearing invariant: a HUMAN CORRECTION IS SACROSANCT — a pinned
// descriptor (`pin:true`, the user_edit pin) BLOCKS overwrite by any later reveal/enrichment (PLAN_03 §1.4 F1),
// and a user edit ALWAYS wins (it sets/overrides the pin). Both functions are pure: same input → same output,
// no mutation of the `existing` argument (they return fresh maps/sets), so they converge on replay.

import type { FieldProvenanceDescriptor, FieldProvenanceMap } from "@leadwolf/types";

/** The provenance source of an incoming (reveal/enrichment) write — a platform-level label, never a workspace id (C2). */
export interface FieldWriteSource {
  /** Platform-level source label (e.g. "provider:zoominfo" | "import:apollo" | "reveal" | "master"). */
  src: string;
  /** match_method that produced the value. */
  mth?: string;
  /** Field confidence ∈ [0,1]. */
  conf?: number;
  /** last_verified_at (ISO string). */
  ver?: string;
  /** observed_at (ISO string). */
  obs?: string;
}

export interface PlanFieldWriteResult {
  /** The fields that may actually be written (pinned fields are excluded). */
  writableFields: Set<string>;
  /** The new `field_provenance` map: existing descriptors, with a fresh `{...source, pin:false}` per writable field. */
  provenance: FieldProvenanceMap;
}

/**
 * Plan a reveal/enrichment write against the existing overlay map (PLAN_03 §1.4 overlay merge). For each
 * incoming field:
 *  - if the existing descriptor is PINNED (`pin === true`) → SKIP it: it is NOT added to `writableFields` and
 *    its descriptor is left UNCHANGED (a user correction is sacrosanct — the overlay pin blocks overwrite);
 *  - otherwise → it is writable, and its descriptor becomes `{ ...source, pin:false }`.
 * `existing` is never mutated — `provenance` starts as a shallow copy.
 */
export function planFieldWrite(
  existing: FieldProvenanceMap,
  incomingFields: string[],
  source: FieldWriteSource,
): PlanFieldWriteResult {
  const writableFields = new Set<string>();
  const provenance: FieldProvenanceMap = { ...existing };

  for (const f of incomingFields) {
    if (existing[f]?.pin === true) {
      // Pinned (user_edit) → leave the descriptor untouched and do not write the value.
      continue;
    }
    writableFields.add(f);
    provenance[f] = { ...source, pin: false };
  }

  return { writableFields, provenance };
}

/**
 * Plan a user hand-edit against the existing overlay map (PLAN_03 §1.4). A user edit ALWAYS wins: for each
 * edited field the descriptor becomes `{ src:"user_edit", pin:true, by:userId, at:atIso }`, OVERRIDING any
 * prior descriptor (including a prior pin). Untouched fields keep their existing descriptors. `existing` is
 * never mutated — the returned map is a shallow copy plus the edits.
 */
export function planUserEdit(
  existing: FieldProvenanceMap,
  editedFields: string[],
  userId: string,
  atIso: string,
): FieldProvenanceMap {
  const provenance: FieldProvenanceMap = { ...existing };

  for (const f of editedFields) {
    const pin: FieldProvenanceDescriptor = { src: "user_edit", pin: true, by: userId, at: atIso };
    provenance[f] = pin;
  }

  return provenance;
}
