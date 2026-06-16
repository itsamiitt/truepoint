// contacts.ts — the Zod schemas + inferred types for the per-workspace data layer and the import pipeline
// (03 §5, 05 §3, ADR-0006). Single source of truth shared by apps/api, apps/workers, apps/web, and
// packages/core. Enums mirror the 03 §5 CHECK constraints exactly. Validation lives here; logic does not.

import { z } from "zod";

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
export const emailStatus = z.enum(["unverified", "valid", "risky", "invalid", "catch_all", "unknown"]);
export type EmailStatus = z.infer<typeof emailStatus>;

export const phoneStatus = z.enum(["direct", "mobile", "hq", "unknown", "valid", "invalid"]);
export type PhoneStatus = z.infer<typeof phoneStatus>;

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

// ── Import request / result DTOs ───────────────────────────────────────────────────────────────────────
export const importRequestSchema = z.object({
  sourceName: sourceName,
  sourceFile: z.string().max(255).optional(),
  mapping: columnMappingSchema,
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

/** The tally returned to the importer (05 §3): how many new vs matched-existing-in-workspace vs skipped. */
export const importSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  errors: z.array(importRowErrorSchema),
});
export type ImportSummary = z.infer<typeof importSummarySchema>;

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

// ── Masked contact view (what search/list returns before reveal — 05 §6/§7) ────────────────────────────
/** A workspace-scoped contact with PII masked until reveal (M3). `emailDomain` is the non-PII facet. */
export const maskedContactSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  emailDomain: z.string().nullable(),
  emailStatus: emailStatus,
  hasEmail: z.boolean(),
  hasPhone: z.boolean(),
  seniorityLevel: seniorityLevel.nullable(),
  department: z.string().nullable(),
  locationCountry: z.string().nullable(),
  locationCity: z.string().nullable(),
  outreachStatus: outreachStatus,
  isRevealed: z.boolean(),
});
export type MaskedContact = z.infer<typeof maskedContactSchema>;
