// retention.ts — Zod schemas + inferred types + constants for the per-data-class, time-based RETENTION engine
// (data-management backlog #6; design in docs/planning/data-management/16-retention-engine-design.md; spec
// 08-compliance §7 + ADR-0025). The single source of truth shared by the policy/run repositories (db), the
// sweep (core/workers), and any admin surface. SHADOW-FIRST + OFF by default: nothing is ever deleted until a
// class is flipped to `enforce` AND the per-tenant flag below is enabled. This file is pure vocabulary + the
// conservative seed defaults — the per-class table/aging-column/cascade mapping is DB-specific and lives with
// the sweep, not here.

import { z } from "zod";

/** Per-tenant gate for the WHOLE engine (existing feature-flag system; default false → fail-closed). With this
 *  off, the sweep skips the tenant entirely — the outermost safety on top of each policy's per-class `mode`. */
export const RETENTION_ENGINE_FLAG_KEY = "retention_engine_enabled";

// ── Vocabulary ───────────────────────────────────────────────────────────────────────────────────────────
/** The data classes the engine governs. `idempotency_keys` is intentionally ABSENT — it is already reclaimed by
 *  the legacy `email_retention_sweep` (idempotencyRepository.deleteExpired, 30d). Classes split v1 (wired first,
 *  low-risk: no contact cascade) vs v2 (contact-cascade / higher-PII) in the design doc; the vocabulary is whole. */
export const retentionDataClass = z.enum([
  // v1 — low-risk, no contact cascade, clean created_at/occurred_at aging
  "email_event",
  "provider_calls",
  "enrichment_job_rows",
  "import_job_rows",
  "data_quality_snapshots",
  "verification_jobs",
  // v2 — contact-cascade / higher PII (dependents-before-tombstone order; periods pending legal)
  "activities",
  "contact_reveals",
  "source_imports",
  "consent_records",
  "contacts",
  "audit_log",
]);
export type RetentionDataClass = z.infer<typeof retentionDataClass>;

/** Per-class lifecycle. `disabled` = the engine ignores the class; `shadow` = COUNT + AUDIT candidates, delete
 *  NOTHING (the default — the evidence-gathering posture); `enforce` = actually purge (batched, leader-locked). */
export const retentionMode = z.enum(["disabled", "shadow", "enforce"]);
export type RetentionMode = z.infer<typeof retentionMode>;

// ── Policy ───────────────────────────────────────────────────────────────────────────────────────────────
/** One retention policy: a class, its time-to-live in days (null = NEVER auto-delete), and its mode. */
export const retentionPolicySchema = z.object({
  dataClass: retentionDataClass,
  ttlDays: z.number().int().positive().nullable(),
  mode: retentionMode,
});
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

/**
 * The admin WRITE contract for defining/updating ONE class's policy (the platform retention-policy admin
 * surface — data-management A2). Kept SEPARATE from `retentionPolicySchema` (the shared read contract) so the
 * writable shape is an explicit, validated boundary: `dataClass` identifies the target class, `ttlDays` is a
 * positive int or null (null = NEVER auto-delete), and `mode` is the lifecycle. Flipping `mode` to `enforce`
 * ARMS real deletion for that class — the server gates the write super_admin-only + audits it, and the UI
 * gates the enforce flip behind an explicit confirm. FUTURE: a compliance_officer co-sign (dual-control)
 * could be required on the enforce flip; out of scope for this pass.
 */
export const retentionPolicyUpdateSchema = z.object({
  dataClass: retentionDataClass,
  ttlDays: z.number().int().positive().nullable(),
  mode: retentionMode,
});
export type RetentionPolicyUpdate = z.infer<typeof retentionPolicyUpdateSchema>;

/**
 * The conservative SEED defaults (design §3/§4). Every class ships `shadow` (deletes nothing); periods anchor on
 * ADR-0025 SLAs (email 90d) + GDPR storage-limitation + analytics value. `contacts` and `audit_log` are `null`
 * (never auto-delete) pending a legal/budget decision — only a human flips a class to `enforce` after confirming.
 */
export const DEFAULT_RETENTION_POLICIES: readonly RetentionPolicy[] = [
  { dataClass: "email_event", ttlDays: 90, mode: "shadow" },
  { dataClass: "provider_calls", ttlDays: 90, mode: "shadow" },
  { dataClass: "enrichment_job_rows", ttlDays: 365, mode: "shadow" },
  { dataClass: "import_job_rows", ttlDays: 365, mode: "shadow" },
  { dataClass: "data_quality_snapshots", ttlDays: 730, mode: "shadow" },
  { dataClass: "verification_jobs", ttlDays: 730, mode: "shadow" },
  { dataClass: "activities", ttlDays: 365, mode: "shadow" },
  { dataClass: "contact_reveals", ttlDays: 180, mode: "shadow" },
  { dataClass: "source_imports", ttlDays: 730, mode: "shadow" },
  { dataClass: "consent_records", ttlDays: 180, mode: "shadow" },
  { dataClass: "contacts", ttlDays: null, mode: "shadow" }, // tombstone-only today; null pending legal/budget
  { dataClass: "audit_log", ttlDays: null, mode: "shadow" }, // compliance trail; null (≈7y) pending counsel
] as const;

// ── Run audit (the shadow-mode evidence: "what WOULD delete") ─────────────────────────────────────────────
/** One retention sweep's outcome for ONE class in ONE tenant — the auditable record a shadow run produces so the
 *  candidate volume is measured BEFORE any class is flipped to `enforce`. `deletedCount` is 0 in shadow mode. */
export const retentionRunSchema = z.object({
  tenantId: z.string().uuid(),
  dataClass: retentionDataClass,
  mode: retentionMode,
  candidateCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  cutoff: z.string().datetime({ offset: true }).nullable(), // null when ttlDays is null (nothing ages out)
  runStartedAt: z.string().datetime({ offset: true }),
  runFinishedAt: z.string().datetime({ offset: true }),
});
export type RetentionRun = z.infer<typeof retentionRunSchema>;
