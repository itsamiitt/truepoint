// contactMergePlan.ts — the PURE, IO-free field-union planner at the heart of the contact TRUE-MERGE engine
// (import-and-data-model-redesign 04 §3.2; S-C4). It decides which of the survivor's seven pin-protected
// scalars are written from the loser and what each field_provenance descriptor becomes — expressed ENTIRELY
// through the canonical `planFieldWrite`/`planUserEdit` pin machinery (DM1/DM6), NEVER re-implemented and
// NEVER re-expressed as SQL `CASE` (data-management/15 §1). The executor (contactMergeRepository) persists the
// result inside its own RLS-scoped tx. Same input → same output; `existing` maps are never mutated — so the
// merge converges on idempotent replay.
//
// THE RULES (04 §3.2):
//   • Default (a field with NO explicit decision): survivor's populated value wins; the loser FILLS BLANKS.
//     A blank survivor field is planned through `planFieldWrite({src:'merge'})`, so a PINNED survivor field is
//     STRUCTURALLY UNOVERWRITABLE even if the UI misbehaves (a pinned blank stays blank).
//   • Explicit user pick of the LOSER's value (`winner:'loser'`): a human assertion → `planUserEdit` (sets
//     pin:true), OVERRIDING any prior descriptor incl. a survivor pin (04 §edge: the user's explicit pick
//     re-pins). May write null (the user asserting the field is blank).
//   • Explicit user pick of the SURVIVOR's value (`winner:'survivor'`): an explicit KEEP — never blank-filled
//     from the loser, even if the survivor field is empty.
//   • `custom_fields`: shallow union, survivor-wins per key (loser fills absent keys) — mirroring the shipped
//     `existing ‖ incoming` write semantics.
// The loser's field_provenance map is NEVER merged into the survivor's (descriptors describe the survivor's
// CURRENT values); it is preserved verbatim in the merge audit payload by the executor (04 §4).

import type { FieldProvenanceMap } from "@leadwolf/types";
import { CONTACT_MERGE_DECIDABLE_FIELDS, type MergeFieldDecision } from "@leadwolf/types";
import { planFieldWrite, planUserEdit } from "./fieldProvenance.ts";

/** The seven decidable scalar values of one contact side (CONTACT_PROVENANCE_FIELDS). `null` = blank. */
export type MergeScalars = Record<(typeof CONTACT_MERGE_DECIDABLE_FIELDS)[number], string | null>;

export interface PlanContactMergeInput {
  survivor: { scalars: MergeScalars; provenance: FieldProvenanceMap; customFields: Record<string, unknown> };
  loser: { scalars: MergeScalars; customFields: Record<string, unknown> };
  decisions: MergeFieldDecision[];
  /** Actor of the merge (for planUserEdit pins on explicit loser picks). */
  userId: string;
  /** Merge commit time (ISO) — the `obs`/`at` stamp on merge-sourced + user-picked descriptors. */
  mergedAtIso: string;
}

export interface PlanContactMergeResult {
  /** Field → value to WRITE on the survivor (loser-sourced blanks-to-fill ∪ explicit loser picks). Only the
   *  fields that actually change from the survivor's current value are meaningful, but all planned writes are
   *  included; the executor applies them verbatim. A value may be `null` (an explicit loser pick clearing it). */
  scalarWrites: Partial<MergeScalars>;
  /** The survivor's NEW field_provenance map (existing descriptors + merge/user-edit descriptors per write). */
  provenance: FieldProvenanceMap;
  /** The merged custom_fields (survivor keys win; loser fills absent). */
  customFields: Record<string, unknown>;
  /** before/after per CHANGED scalar — the FieldChangeAuditMetadata.fields payload (04 §4). */
  fieldChanges: Record<string, { b: unknown; a: unknown }>;
}

const isBlank = (v: string | null | undefined): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * Plan the field union of a contact merge (04 §3.2) — pure. Reuses `planFieldWrite` (pin-respecting default
 * fills) and `planUserEdit` (human loser picks) verbatim; no SQL, no IO, no mutation of the inputs.
 */
export function planContactMerge(input: PlanContactMergeInput): PlanContactMergeResult {
  const { survivor, loser, decisions, userId, mergedAtIso } = input;

  const decided = new Set(decisions.map((d) => d.field));
  const loserPickFields = decisions.filter((d) => d.winner === "loser").map((d) => d.field);

  // Default fields (no explicit decision) where the survivor is blank and the loser has a value → fill.
  const autoFillCandidates = CONTACT_MERGE_DECIDABLE_FIELDS.filter(
    (f) => !decided.has(f) && isBlank(survivor.scalars[f]) && !isBlank(loser.scalars[f]),
  );

  // Pin-respecting default fills (a pinned survivor field is dropped from writableFields structurally).
  const { writableFields, provenance: p1 } = planFieldWrite(survivor.provenance, autoFillCandidates, {
    src: "merge",
    obs: mergedAtIso,
  });

  // Explicit loser picks are human assertions → planUserEdit re-pins (overrides even a survivor pin).
  const provenance = planUserEdit(p1, loserPickFields, userId, mergedAtIso);

  const scalarWrites: Partial<MergeScalars> = {};
  for (const f of writableFields) scalarWrites[f as keyof MergeScalars] = loser.scalars[f as keyof MergeScalars];
  for (const f of loserPickFields) scalarWrites[f] = loser.scalars[f];

  const fieldChanges: Record<string, { b: unknown; a: unknown }> = {};
  for (const f of Object.keys(scalarWrites) as (keyof MergeScalars)[]) {
    const after = scalarWrites[f] ?? null;
    const before = survivor.scalars[f] ?? null;
    if (after !== before) fieldChanges[f] = { b: before, a: after };
  }

  // Shallow union, survivor-wins per key.
  const customFields = { ...loser.customFields, ...survivor.customFields };

  return { scalarWrites, provenance, customFields, fieldChanges };
}
