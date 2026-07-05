// contacts.ts — the Zod schemas + inferred types for the per-workspace data layer and the import pipeline
// (03 §5, 05 §3, ADR-0006). Single source of truth shared by apps/api, apps/workers, apps/web, and
// packages/core. Enums mirror the 03 §5 CHECK constraints exactly. Validation lives here; logic does not.

import { z } from "zod";
import { revealType } from "./billing.ts";
import { importRejectCode } from "./importReject.ts";
import { freshnessStatus } from "./intel.ts";

// ── Enums (mirror 03 §5 CHECK constraints) ─────────────────────────────────────────────────────────────
/** Provenance origin of an import — the only source-trust signal under the per-workspace model (ADR-0006). */
export const sourceName = z.enum([
  "apollo",
  "zoominfo",
  "linkedin",
  "sales_navigator",
  "hubspot",
  "salesforce",
  "clearbit",
  "manual",
]);
export type SourceName = z.infer<typeof sourceName>;

/** Email field correctness (set by verify-on-reveal in M4) — distinct from lead score (quality). */
export const emailStatus = z.enum([
  "unverified",
  "valid",
  "risky",
  "invalid",
  "catch_all",
  "unknown",
]);
export type EmailStatus = z.infer<typeof emailStatus>;

export const phoneStatus = z.enum(["direct", "mobile", "hq", "unknown", "valid", "invalid"]);
export type PhoneStatus = z.infer<typeof phoneStatus>;

/** Carrier line type (Twilio Lookup line_type_intelligence) — the TCPA mobile-vs-landline gating signal
 *  (01 §5.3), distinct from phone_status (the reachability/kind grade). `unknown` = couldn't classify. */
export const phoneLineType = z.enum(["mobile", "landline", "voip", "unknown"]);
export type PhoneLineType = z.infer<typeof phoneLineType>;

export const seniorityLevel = z.enum(["c_suite", "vp", "director", "manager", "ic", "other"]);
export type SeniorityLevel = z.infer<typeof seniorityLevel>;

export const outreachStatus = z.enum([
  "new",
  "in_sequence",
  "replied",
  "meeting_booked",
  "disqualified",
  "nurture",
  "unsubscribed",
]);
export type OutreachStatus = z.infer<typeof outreachStatus>;

// ── Canonical import shape ─────────────────────────────────────────────────────────────────────────────
/**
 * The fields the import column-mapper targets. A `ColumnMapping` maps each canonical field to a source
 * header; everything else in the source row is preserved verbatim in `source_imports.raw_data`.
 */
export const canonicalField = z.enum([
  "firstName",
  "lastName",
  "email",
  "jobTitle",
  "seniorityLevel",
  "department",
  "phone",
  "linkedinUrl",
  "linkedinPublicId",
  "salesNavProfileUrl",
  "salesNavLeadId",
  "locationCountry",
  "locationCity",
  "accountName",
  "accountDomain",
]);
export type CanonicalField = z.infer<typeof canonicalField>;

/** Map of canonical field → the source column header that supplies it (partial; unmapped fields are skipped). */
const columnMappingShape = Object.fromEntries(
  canonicalField.options.map((f) => [f, z.string().min(1)]),
) as Record<CanonicalField, z.ZodString>;
export const columnMappingSchema = z.object(columnMappingShape).partial();
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

/** One row after column-mapping + normalization, before dedup/encryption. All fields optional but at least one identity key is required downstream. */
export const canonicalContactRowSchema = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  email: z.string().email().max(320).optional(),
  jobTitle: z.string().max(255).optional(),
  seniorityLevel: seniorityLevel.optional(),
  department: z.string().max(100).optional(),
  phone: z.string().max(50).optional(),
  linkedinUrl: z.string().max(500).optional(),
  linkedinPublicId: z.string().max(255).optional(),
  salesNavProfileUrl: z.string().max(500).optional(),
  salesNavLeadId: z.string().max(255).optional(),
  locationCountry: z.string().max(100).optional(),
  locationCity: z.string().max(100).optional(),
  accountName: z.string().max(255).optional(),
  accountDomain: z.string().max(255).optional(),
});
export type CanonicalContactRow = z.infer<typeof canonicalContactRowSchema>;

// ── Hand-edit overlay (PLAN_03 §1.4) — the user pin setter's request shape ──────────────────────────────
/**
 * The SEVEN scalar overlay profile fields a user may hand-edit via `PATCH /contacts/:id` (PLAN_03 §3.1
 * CONTACT_PROVENANCE_FIELDS). Every field is optional (edit a subset) and nullable (`null` = clear/blank the
 * field); an omitted key is left as-is. Max-lengths mirror `canonicalContactRowSchema` exactly. The `.refine`
 * makes an empty `{}` body a 400 — at least one field must be provided. Validation only; the pin + RLS write
 * live in core (`editContactFields`).
 */
export const contactFieldEditSchema = z
  .object({
    firstName: z.string().max(100).nullable().optional(),
    lastName: z.string().max(100).nullable().optional(),
    jobTitle: z.string().max(255).nullable().optional(),
    seniorityLevel: seniorityLevel.nullable().optional(),
    department: z.string().max(100).nullable().optional(),
    locationCountry: z.string().max(100).nullable().optional(),
    locationCity: z.string().max(100).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to edit.");
export type ContactFieldEdit = z.infer<typeof contactFieldEditSchema>;

// ── Conflict policy (G-IMP-5) ────────────────────────────────────────────────────────────────────────
/**
 * What the import does when an incoming row matches an existing workspace contact by a dedup key (30 §3/§7,
 * ADR-0036 §4). Replaces the old silent last-writer-wins (the G-IMP-5 gap) with an explicit, user-chosen
 * policy threaded all the way into `runImport`'s `ON CONFLICT` step:
 *   - `overwrite`  — update the existing contact with the incoming values (the legacy last-writer-wins).
 *   - `skip`       — keep the existing contact unchanged; the incoming row is counted as a duplicate, not applied.
 *   - `keep_both`  — intent: keep BOTH as separate records. The overlay enforces one contact per identity key
 *                    per workspace (03 §5/§11), so a genuinely separate record needs ER survivorship
 *                    (30 §5, ADR-0021); until that lands, a match under keep_both is held back as a duplicate
 *                    (not overwritten), while a NON-matching row inserts as a new contact.
 */
export const conflictPolicy = z.enum(["overwrite", "skip", "keep_both"]);
export type ConflictPolicy = z.infer<typeof conflictPolicy>;

/** The safe default: keep existing data on a match (no silent overwrite). The user opts into overwriting. */
export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = "skip";

// ── Import request / result DTOs ───────────────────────────────────────────────────────────────────────
/**
 * Optional target of an "import into list" job (list-plan/03 §2.2, Phase 2): every landed row is also added
 * to this list as a `list_members` row (`added_via='import'`, `source_import_id` set). The `listId` is the
 * id of a list in the CALLER's workspace — it is validated server-side against the verified token's workspace
 * before the job runs (the client-supplied id is never trusted; list-plan D4). Absent → a plain import that
 * lands rows in the workspace overlay with no list linkage (the pre-Phase-2 behaviour, unchanged).
 */
export const importTargetSchema = z.object({
  listId: z.string().uuid(),
});
export type ImportTarget = z.infer<typeof importTargetSchema>;

export const importRequestSchema = z.object({
  sourceName: sourceName,
  sourceFile: z.string().max(255).optional(),
  mapping: columnMappingSchema,
  /** How to resolve a match against an existing workspace contact (G-IMP-5). Defaults to `skip` (no overwrite). */
  conflictPolicy: conflictPolicy.default(DEFAULT_CONFLICT_POLICY),
  /** Optional "import into list" target (list-plan/03 §2.2). Absent = land in the overlay, no list linkage. */
  target: importTargetSchema.optional(),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;

/** Per-row outcome of the dedup upsert (drives the new-vs-matched summary). */
export const importRowOutcome = z.enum(["created", "matched", "skipped"]);
export type ImportRowOutcome = z.infer<typeof importRowOutcome>;

export const importRowErrorSchema = z.object({
  row: z.number().int().nonnegative(), // 0-based index in the parsed file
  message: z.string(),
});
export type ImportRowError = z.infer<typeof importRowErrorSchema>;

/**
 * A rejected input row + WHY it was rejected (30 §4, ADR-0036 §7 — the rejected-rows artifact). One reason
 * per offending field (`field` is null for a whole-row reason, e.g. "no identity key"). Echoes the RAW input
 * row so a downloadable rejected-rows file lets the user fix and re-import only the failures. Because `raw`
 * carries un-masked PII, this only ever rides the import-owner's own summary — never a shared/list surface.
 */
export const rejectedRowSchema = z.object({
  row: z.number().int().nonnegative(), // 0-based index in the parsed file
  field: z.string().nullable(), // canonical field at fault, or null for a whole-row reason
  reason: z.string(),
  /** The typed reject code (importReject.ts) — the machine-readable half of the reason, shared by the ledger's
   *  `reject_reason` token and the artifacts' `tp__error_code` column (S-I7, 08 §4). Optional so legacy
   *  producers and the flag-off path stay byte-identical; populated by every core producer from S-I7 on. */
  code: importRejectCode.optional(),
  raw: z.record(z.string(), z.string()), // the verbatim source row (header → value)
});
export type RejectedRow = z.infer<typeof rejectedRowSchema>;

/** The tally returned to the importer (05 §3, 30 §4): new vs matched vs skipped, plus the three-way reject /
 *  duplicate accounting and the downloadable rejected-rows artifact (G-IMP-1). `rejected` rows never landed;
 *  `duplicates` matched an existing contact and were not applied under a `skip` policy. */
export const importSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** Rows that failed validation/constraints and did NOT land (= rejectedRows.length distinct rows). */
  rejected: z.number().int().nonnegative(),
  /** Rows held back because they matched an existing contact under a `skip` conflict policy. */
  duplicates: z.number().int().nonnegative(),
  /**
   * NEW members added to the import's target list (list-plan/03 §2.2): the count of landed contacts that
   * became a NEW `list_members` row this run (idempotent — a contact already in the list is not recounted).
   * `0` for a plain import (no `target`). The import receipt surfaces this as "added to <list>".
   */
  addedToList: z.number().int().nonnegative().default(0),
  errors: z.array(importRowErrorSchema),
  /** The rejected-rows artifact (G-IMP-1): each reject + reason + raw row, for a downloadable error file. */
  rejectedRows: z.array(rejectedRowSchema),
  /** Reject breakdown keyed by a STABLE, NON-PII label (e.g. "email: invalid value", "Missing identifier") →
   *  count; one bump per rejected row (its primary reason), so it sums to `rejected`. A free-text catch-path
   *  message is bucketed as "Processing error", never surfaced verbatim (database-management-research G08). */
  rejectHistogram: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type ImportSummary = z.infer<typeof importSummarySchema>;

/** Counts for the pre-commit validation preview (30 §4, G-IMP-1) — what the wizard shows before the user
 *  confirms the import. `duplicate` is the WITHIN-FILE duplicate estimate (against-existing dedup is the
 *  worker's job); `valid` is rows that would attempt to land. total = valid + rejected + duplicate. */
export const importPreviewSchema = z.object({
  total: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  /** A bounded sample of rejected rows with per-field reasons (the full set is too large to ship inline). */
  sampleRejectedRows: z.array(rejectedRowSchema),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

// ── Async import job (queue) DTOs (16 §3.2) ──────────────────────────────────────────────────────────────
/**
 * The BullMQ queue name shared by the API *producer* (apps/api import slice) and the workers *consumer*
 * (apps/workers). It lives here, in the leaf types package both apps already depend on, so the producer and
 * consumer can never drift — and so apps never import apps (.dependency-cruiser.cjs `apps-never-import-apps`).
 */
export const IMPORTS_QUEUE = "imports";

/** Lifecycle of a queued import job. `queued` is what the 202 accept-response reports at enqueue time. */
export const importJobStatus = z.enum(["queued", "active", "completed", "failed", "unknown"]);
export type ImportJobStatus = z.infer<typeof importJobStatus>;

/** The 202 accept-response when an import is taken for background processing: a job ref the importer can poll. */
export const importJobRefSchema = z.object({
  jobId: z.string(),
  status: importJobStatus,
});
export type ImportJobRef = z.infer<typeof importJobRefSchema>;

/** Dead-letter queue name for import jobs that exhaust their retries (16 §3.2). Shared producer/consumer. */
export const IMPORTS_DLQ = "imports-dlq";

/** Coarse progress the import worker reports via job.updateProgress; the status endpoint echoes it back.
 *  `failed` mirrors summary.rejected (rows that did not land); kept named `failed` for the progress UI. */
export const importProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type ImportProgress = z.infer<typeof importProgressSchema>;

/** The polled status of an import job (GET /import/:jobId). `summary`/`failedReason` fill in once it settles. */
export const importJobStatusResponseSchema = z.object({
  jobId: z.string(),
  status: importJobStatus,
  progress: importProgressSchema.nullable(),
  summary: importSummarySchema.nullable(),
  failedReason: z.string().nullable(),
});
export type ImportJobStatusResponse = z.infer<typeof importJobStatusResponseSchema>;

/** A PII-FREE record of an import job that exhausted its retries, written to the dead-letter queue. Carries
 *  scope + provenance + the failure reason for ops triage — never the raw rows (those hold un-encrypted PII). */
export const importDeadLetterSchema = z.object({
  originalJobId: z.string(),
  tenantId: z.string(),
  workspaceId: z.string(),
  sourceName: sourceName,
  sourceFile: z.string().nullable(),
  importedByUserId: z.string().nullable(),
  failedReason: z.string(),
  attemptsMade: z.number().int().nonnegative(),
});
export type ImportDeadLetter = z.infer<typeof importDeadLetterSchema>;

// ── Data Health (list-plan/06 §3.3) — the derived, non-PII health badge on the masked list-member row ────
/** The read-side, derived data-health a masked surface (the list-detail Data Health column) renders: the
 *  0–100 `computeContactDataQuality` score + its freshness_status band. Both are computed from non-PII
 *  present-flags + the email/phone statuses + the last-verified age, so it is safe on the masked DTO. Optional
 *  on `MaskedContact`: surfaces that don't need it (or can't cheaply derive `hasName`/`hasLinkedin`) omit it. */
export const contactDataHealthSchema = z.object({
  score: z.number().int().min(0).max(100),
  freshnessStatus: freshnessStatus,
});
export type ContactDataHealth = z.infer<typeof contactDataHealthSchema>;

/** Per-workspace data-quality rollup (10 §5 / 22) — the live aggregate the Data Health dashboard reads: raw
 *  counts (the UI derives fill / bounce / freshness RATES) over the workspace's LIVE contacts. Non-PII (counts +
 *  present-flags + statuses), workspace-scoped by RLS. Freshness uses the record-level email-SLA proxy (ADR-0025).
 *
 *  `multiSourceContacts` is a COVERAGE proxy (data-management #8): contacts whose field_provenance attributes
 *  fields to ≥2 distinct data sources (user_edit excluded — a human correction is not a source). It is OPTIONAL
 *  and computed ONLY in the daily snapshot (the per-contact jsonb scan is too heavy for the live per-request read),
 *  so the live GET /home/data-quality omits it and the persisted snapshots / trend carry it. `conflictContacts`
 *  is the TRUE "sources DISAGREE" count (distinct from coverage): the import merge now stamps a `cf` flag on
 *  field_provenance when a field is overwritten by a different source with a different normalized value
 *  (markConflicts), and this counts contacts carrying any such flag. Forward-only — only imports landing after it
 *  shipped record the disagreement. Also periodic-only + optional. */
export const workspaceDataQualitySchema = z.object({
  total: z.number().int().min(0),
  withName: z.number().int().min(0),
  withEmail: z.number().int().min(0),
  withPhone: z.number().int().min(0),
  withTitle: z.number().int().min(0),
  withCompany: z.number().int().min(0),
  withLinkedin: z.number().int().min(0),
  withLocation: z.number().int().min(0),
  emailValid: z.number().int().min(0),
  emailRisky: z.number().int().min(0),
  emailInvalid: z.number().int().min(0),
  emailCatchAll: z.number().int().min(0),
  emailUnverified: z.number().int().min(0),
  emailUnknown: z.number().int().min(0),
  phoneValid: z.number().int().min(0),
  phoneInvalid: z.number().int().min(0),
  phoneMobile: z.number().int().min(0),
  phoneLandline: z.number().int().min(0),
  phoneVoip: z.number().int().min(0),
  fresh: z.number().int().min(0),
  stale: z.number().int().min(0),
  neverVerified: z.number().int().min(0),
  // Multi-source coverage (data-management #8) — OPTIONAL, periodic-only (see the doc comment above).
  multiSourceContacts: z.number().int().min(0).optional(),
  // TRUE cross-source conflict count (data-management #8) — OPTIONAL, periodic-only. Contacts with ≥1 field where
  // two sources actually DISAGREED on the value (flagged at import-merge by markConflicts). Distinct from coverage
  // (mere breadth); forward-only — a contact only counts once a conflicting import lands after this shipped.
  conflictContacts: z.number().int().min(0).optional(),
});
export type WorkspaceDataQuality = z.infer<typeof workspaceDataQualitySchema>;

/** One Data Health trend point — a workspace's WorkspaceDataQuality rollup at a capture time (10 §5). The
 *  dashboard's history read returns a newest-first series of these (from data_quality_snapshots). */
export const dataQualityTrendPointSchema = z.object({
  capturedAt: z.string().datetime({ offset: true }),
  metrics: workspaceDataQualitySchema,
});
export type DataQualityTrendPoint = z.infer<typeof dataQualityTrendPointSchema>;
export const dataQualityTrendSchema = z.array(dataQualityTrendPointSchema);

/** One freshness re-verification run — a completed runReverification pass's tally + window (PLAN_06, from
 *  verification_jobs). Non-PII (counts + timestamps). The Data Health "re-verification activity" read returns a
 *  newest-first series. */
export const reverificationRunSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  scanned: z.number().int().min(0),
  reverified: z.number().int().min(0),
  errored: z.number().int().min(0),
  createdAt: z.string().datetime({ offset: true }),
});
export type ReverificationRun = z.infer<typeof reverificationRunSchema>;
export const reverificationRunsSchema = z.array(reverificationRunSchema);

// ── Masked contact view (what search/list returns before reveal — 05 §6/§7) ────────────────────────────
/** A workspace-scoped contact with PII masked until reveal (M3). `emailDomain` is the non-PII facet. */
export const maskedContactSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  emailDomain: z.string().nullable(),
  emailStatus: emailStatus,
  // Phone field-correctness verdict (list-plan/06 §3.2) — non-PII (a status label, never the number). Null
  // until a verification has graded the phone. Feeds the verification sub-score + the Data Health column.
  phoneStatus: phoneStatus.nullable(),
  // Carrier line type (Twilio Lookup) — non-PII (a classification, never the number); the TCPA mobile-vs-landline
  // signal surfaced pre-reveal so the UI can flag dial risk. Optional: populated by the main list/search/export
  // projection (like `dataHealth`); surfaces that don't compute it omit it.
  phoneLineType: phoneLineType.nullable().optional(),
  hasEmail: z.boolean(),
  hasPhone: z.boolean(),
  seniorityLevel: seniorityLevel.nullable(),
  department: z.string().nullable(),
  locationCountry: z.string().nullable(),
  locationCity: z.string().nullable(),
  outreachStatus: outreachStatus,
  isRevealed: z.boolean(),
  // Non-PII reporting dimensions (T4b): member + funnel/health-date filtering over the masked list.
  ownerUserId: z.string().nullable(), // the member who revealed (= owns) the contact; null until revealed.
  createdAt: z.string().datetime({ offset: true }), // when the workspace row was created (ISO-8601).
  // When the contact's PII was last verified (list-plan/06 §3.3) — drives staleness. Null = never verified.
  lastVerifiedAt: z.string().datetime({ offset: true }).nullable(),
  // The derived Data Health (score + freshness band). Optional — populated only by the surfaces that compute
  // it (the list-detail members table). Absent on surfaces that don't render the column. Never trusted as
  // input (read-side only); the server is the single computer of record (list-plan/06 §3.3).
  dataHealth: contactDataHealthSchema.optional(),
  // Which reveal_types THIS workspace already owns a claim for (non-PII: just the set email|phone|full_profile,
  // never the values). Optional — populated only by the search projection that computes it (like dataHealth /
  // phoneLineType). Drives the grid's per-row reveal affordance + "revealed" badge without decrypting the
  // dataset; the actual PII is fetched separately (GET/POST revealed) only for owned rows.
  revealedTypes: z.array(revealType).optional(),
});
export type MaskedContact = z.infer<typeof maskedContactSchema>;
