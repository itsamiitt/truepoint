// provenanceEvent.ts — the vocabulary and draft shape for `provenance_event`, the field-grain assertion log
// behind docs/strategy/08-architecture.md invariant 1 ("nothing writes to the materialized graph except
// through a provenance_event") and outcome A-01.
//
// RELATIONSHIP TO fieldProvenance.ts, because the two are easy to confuse:
//   • fieldProvenance.ts is the CURRENT-STATE map — one WINNING descriptor per field, stored inline on the
//     row, deliberately tiny because it is paid for on billions of golden rows.
//   • this file is the EVENT — every assertion ever made about a field, whether it won or lost, append-only
//     and off-row. The map is a projection of the stream; the stream is not a bigger map.
// Keeping them separate is what lets confidence be recomputed (Phase 2 decay) and lets a merge retain the
// losing side's evidence instead of destroying it.
//
// These enums MUST equal the CHECK constraints in migration 0089 exactly. They are the app-edge half of a
// belt-and-braces pair: the database refuses a bad value, and this refuses it earlier with a better message.

import { z } from "zod";
// Reused, not redeclared. A second lawful-basis vocabulary is a vocabulary that will drift, and 09-compliance
// rule 4 turns any drift here into "data entered the graph under a basis nothing recognises".
import { lawfulBasis } from "./compliance.ts";

/** Which kind of thing the assertion is about. Layer 0 (person/company/employment/email/phone) and the
 *  workspace overlay (contact/account) share ONE stream: one erasure fan-out, one retention class, one
 *  suppression egress. */
export const provenanceEntityType = z.enum([
  "person",
  "company",
  "employment",
  "email",
  "phone",
  "contact",
  "account",
]);
export type ProvenanceEntityType = z.infer<typeof provenanceEntityType>;

/**
 * What the event does to the field. These are not all "writes":
 *   assert     — a source states a value (the common case)
 *   confirm    — a human or signal agrees with the value already held (raises corroboration, changes nothing)
 *   deny       — a human or signal contradicts it (the correction-at-the-moment-of-pain contribution, C-01)
 *   correct    — supplies a replacement value
 *   verify     — a verification run graded the value (email SMTP, phone HLR), not a new value
 *   pin        — a human override that blocks later automated overwrite (mirrors fieldProvenance `pin`)
 *   tombstone  — erasure. 09-compliance: erasure is a tombstone EVENT plus reprocess, never a delete, because
 *                a deleted row cannot evidence that the erasure was honoured.
 *   merge      — this assertion moved to a survivor entity during entity resolution
 */
export const provenanceAction = z.enum([
  "assert",
  "confirm",
  "deny",
  "correct",
  "verify",
  "pin",
  "tombstone",
  "merge",
]);
export type ProvenanceAction = z.infer<typeof provenanceAction>;

/** WHERE the assertion came from, at channel granularity — this is the axis 07-data-flywheel orders by
 *  effort-per-datum, and the one confidence weighting reads (an SMTP verify outranks a pattern inference). */
export const provenanceSourceType = z.enum([
  "provider",
  "import",
  "coop",
  "forge",
  "crawl",
  "user_edit",
  "reveal",
  "extension",
  "crm_sync",
  "mailbox",
]);
export type ProvenanceSourceType = z.infer<typeof provenanceSourceType>;

/** Whether the assertion counts yet. `pending` is the 09-compliance rule 4 holding pen: an event whose lawful
 *  basis could not be derived is RECORDED but does NOT project, so untaggable data never reaches the graph
 *  while still leaving an auditable trace that it arrived. */
export const provenanceAcceptanceState = z.enum(["accepted", "pending", "rejected", "superseded"]);
export type ProvenanceAcceptanceState = z.infer<typeof provenanceAcceptanceState>;

/** The entity kinds that live in the workspace overlay and therefore MUST carry `scopeRef`. Layer-0 kinds must
 *  NOT — mirrors the provenance_event_scope_matches_layer CHECK in 0089. */
export const OVERLAY_ENTITY_TYPES = ["contact", "account"] as const;

/**
 * The platform default basis for B2B business-contact data (decision D6). Lives in this LEAF package, not in
 * @leadwolf/core's resolver, because both sides of the dependency graph need it: core resolves it for the
 * import path, and packages/db builds forge-sync drafts directly — and db cannot import core without creating
 * a cycle. A constant duplicated either side of that boundary is a constant that will drift.
 *
 * Deliberately NOT 'consent': claiming consent we never collected asserts a legal fact about a person that no
 * record supports. Legitimate interest is the honest default for this data class and is something an
 * assessment can actually be written against.
 */
export const DEFAULT_LAWFUL_BASIS = "legitimate_interest" satisfies z.infer<typeof lawfulBasis>;

/**
 * One assertion, as the writer supplies it. `id` and `recordedAt` are database-assigned.
 *
 * PAYLOAD RULE (09-compliance rule 3, and the reason this is enforced at the edge rather than trusted):
 * `payload` carries `{ v: <normalized value> }` for NON-PII scalars only. For email and phone it stays EMPTY
 * and the value is referenced through the encrypted channel row. A provenance log that copied channel values
 * would become a second, unencrypted, un-revealed store of exactly the PII the reveal paywall and the DSAR
 * fan-out exist to control.
 */
export const provenanceEventDraftSchema = z
  .object({
    entityType: provenanceEntityType,
    entityId: z.string().uuid(),
    /** The field asserted, e.g. "jobTitle" | "primary_domain". "*" for whole-entity actions (merge, tombstone). */
    field: z.string().min(1).max(50),
    action: provenanceAction,
    sourceType: provenanceSourceType,
    /** Platform-level source label — "zoominfo" | "apollo". NEVER a workspace id (C-02), same rule as
     *  fieldProvenance `src`. */
    sourceName: z.string().max(50).nullish(),
    method: z.string().max(30).nullish(),
    /** Opaque contributor handle (forge.contributor.id). Resolvable ONLY inside the forge schema — see
     *  decisions.md D5. Never logged, never returned in an API response, never joined in `public`. */
    contributorRef: z.string().uuid().nullish(),
    lawfulBasis,
    payload: z.record(z.string(), z.unknown()).default({}),
    confidence: z.number().min(0).max(1).nullish(),
    acceptanceState: provenanceAcceptanceState.default("accepted"),
    /** The `source_records` row this assertion was read out of, when there is one. */
    sourceRecordId: z.string().uuid().nullish(),
    /** workspace_id for overlay events; null for Layer 0. */
    scopeRef: z.string().uuid().nullish(),
    /** VALID time — when the source says the fact held. Distinct from recordedAt (when we learned it);
     *  conflating them makes a late-arriving old fact look fresh, which is precisely the decay bug S-09 exists
     *  to avoid. */
    observedAt: z.date().nullish(),
  })
  .superRefine((draft, ctx) => {
    const isOverlay = (OVERLAY_ENTITY_TYPES as readonly string[]).includes(draft.entityType);
    if (isOverlay && !draft.scopeRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeRef"],
        message: "overlay events (contact/account) must carry scopeRef (the workspace id)",
      });
    }
    if (!isOverlay && draft.scopeRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeRef"],
        message: "Layer-0 events must not carry scopeRef — it would leak a tenant hint (C-02)",
      });
    }
    // The payload rule, enforced rather than documented: channel PII is referenced, never copied.
    if ((draft.entityType === "email" || draft.entityType === "phone") && draft.payload.v != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "v"],
        message:
          "email/phone events must not carry a value — reference the encrypted channel row instead (09 rule 3)",
      });
    }
  });
export type ProvenanceEventDraft = z.infer<typeof provenanceEventDraftSchema>;
