// planEvents.ts — PURE derivation of provenance_event drafts from an already-planned field write
// (08-architecture invariant 1). No IO, no mutation of its inputs: same input → same output, so it converges
// on replay exactly like the fieldProvenance fold it sits beside.
//
// WHY A SEPARATE FUNCTION RATHER THAN AN EXTRA RETURN FIELD ON planFieldWrite
// The original plan was to widen PlanFieldWriteResult with `events`, on the reasoning that every caller
// destructures the result so the change would force each site to supply the event context. It would not:
// `const { writableFields, provenance } = planFieldWrite(...)` keeps compiling when a third field appears, so
// the "forcing function" does not exist. What a widened signature WOULD do is change seven call sites plus
// their tests in one commit. This composes instead — planFieldWrite decides WHAT may be written and stays
// untouched; this decides what that write ASSERTED. Same purity, same testability, no big-bang edit.
//
// THE FIELD SET COMES FROM writableFields, NOT from the incoming fields. A field skipped because a human
// pinned it was not asserted by this source, and recording an event for it would inflate the corroboration
// count for a value that never won — and corroboration count IS the confidence signal and the S-10 badge.

import type {
  LawfulBasis,
  ProvenanceAcceptanceState,
  ProvenanceAction,
  ProvenanceEntityType,
  ProvenanceEventDraft,
  ProvenanceSourceType,
} from "@leadwolf/types";
import type { FieldWriteSource } from "../prospect/fieldProvenance.ts";

/** The entity kinds whose values are channel PII — their events reference the encrypted row, never copy it. */
const CHANNEL_ENTITY_TYPES: ReadonlySet<ProvenanceEntityType> = new Set(["email", "phone"]);

export interface ProvenanceEventContext {
  /** Which entity the assertion is about. */
  entityType: ProvenanceEntityType;
  entityId: string;
  /** workspace_id for overlay entities (contact/account); omit for Layer 0. Enforced both by the draft schema
   *  and by the scope/layer CHECK in migration 0089. */
  scopeRef?: string | null;
  sourceType: ProvenanceSourceType;
  lawfulBasis: LawfulBasis;
  /** From acceptanceFor() — a capture with no declared basis is recorded as 'pending' and does not project. */
  acceptanceState?: ProvenanceAcceptanceState;
  /** Opaque forge.contributor id. Never logged, never returned in an API response. */
  contributorRef?: string | null;
  /** The source_records row this assertion was read out of, when there is one. */
  sourceRecordId?: string | null;
}

export interface PlanEventsInput {
  context: ProvenanceEventContext;
  /** The fields actually being written — planFieldWrite's writableFields. */
  writableFields: Iterable<string>;
  /** The same source descriptor the fold was given, so the event and the descriptor cannot disagree. */
  source: FieldWriteSource;
  /** What the write did. Defaults to 'assert'; user edits pass 'pin', merges 'merge', corrections 'correct'. */
  action?: ProvenanceAction;
  /** Current values by field, when known. Used only for non-channel fields — see the payload rule below. */
  values?: Readonly<Record<string, unknown>>;
}

/**
 * Derive one draft per written field.
 *
 * PAYLOAD RULE (09-compliance rule 3): `{ v: value }` for non-PII scalars, and EMPTY for email/phone, whose
 * values live in the encrypted channel row and are referenced rather than copied. A provenance log that copied
 * channel values would become a second, unencrypted, never-revealed store of exactly the PII the reveal
 * paywall and the DSAR fan-out exist to control. The draft schema rejects a violation too — this is the belt,
 * that is the braces.
 *
 * `observedAt` comes from the source descriptor's `obs` (VALID time — when the source says the fact held), NOT
 * from now(). Defaulting it to now() would make a late-arriving old fact look freshly observed, which is the
 * precise error the S-09/S-13 decay work depends on not making.
 */
export function planProvenanceEvents(input: PlanEventsInput): ProvenanceEventDraft[] {
  const { context, source, values } = input;
  const action: ProvenanceAction = input.action ?? "assert";
  const isChannel = CHANNEL_ENTITY_TYPES.has(context.entityType);
  const observedAt = parseObserved(source.obs);

  const drafts: ProvenanceEventDraft[] = [];
  for (const field of input.writableFields) {
    const value = values?.[field];
    drafts.push({
      entityType: context.entityType,
      entityId: context.entityId,
      field,
      action,
      sourceType: context.sourceType,
      // The platform-level label the descriptor carries ("provider:zoominfo" | "import:apollo"). NEVER a
      // workspace id — the same C-02 rule fieldProvenance's `src` follows.
      sourceName: source.src ?? null,
      method: source.mth ?? null,
      contributorRef: context.contributorRef ?? null,
      lawfulBasis: context.lawfulBasis,
      payload: isChannel || value === undefined ? {} : { v: value },
      confidence: source.conf ?? null,
      acceptanceState: context.acceptanceState ?? "accepted",
      sourceRecordId: context.sourceRecordId ?? null,
      scopeRef: context.scopeRef ?? null,
      observedAt,
    });
  }
  return drafts;
}

/** An unparseable or absent `obs` yields null rather than now(): "we do not know when this held" is a
 *  different and more useful claim than "it held at import time". */
function parseObserved(obs: string | undefined): Date | null {
  if (!obs) return null;
  const d = new Date(obs);
  return Number.isNaN(d.getTime()) ? null : d;
}
