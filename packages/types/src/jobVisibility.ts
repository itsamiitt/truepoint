// jobVisibility.ts — the job-visibility contract (import-and-data-model-redesign 10; the G01 fix). Single
// source of truth shared by apps/api (route wiring builds the viewer from MIDDLEWARE OUTPUTS only),
// packages/core (job-status helpers thread it through), and packages/db (the ONE jobVisibility predicate
// consumes it inside every job-list/get repository signature). The policy itself — members see their own
// jobs + shared jobs; workspace admins/owners see all with creator attribution — lives in the predicate
// (packages/db/src/repositories/jobVisibility.ts), never in routes or the frontend.

import { z } from "zod";
import type { WorkspaceRole } from "./auth.ts";

// ── Rollout gate ─────────────────────────────────────────────────────────────────────────────────────────
/** Per-tenant feature-flag key for owner-scoped job visibility (default false → fail-closed to the shipped
 *  workspace-wide behavior). The TWO-LAYER gate: the global env.JOB_VISIBILITY_SCOPED kill-switch must be on
 *  AND this per-tenant flag enabled before any job surface narrows. Mirrors BULK_IMPORT_FLAG_KEY
 *  (bulkImport.ts) — the shared key lives here so api/core/db can never drift. Retired at S-V6. */
export const JOB_VISIBILITY_FLAG_KEY = "job_visibility_scoped";

// ── The viewer context (10 §4.1) ─────────────────────────────────────────────────────────────────────────
/**
 * WHO is looking at a job surface. Constructed ONLY from middleware outputs: `userId` = the verified token's
 * `claims.sub` (never the body), `role` = the caller's ACTIVE workspace role resolved server-side per request
 * (requireRole → getWorkspaceRole, or an explicit membership lookup on routes without the guard). `scoped`
 * carries the dual-gate result (env kill-switch AND per-tenant flag): while false the predicate
 * short-circuits to workspace-wide — byte-identical shipped behavior (10 §Rollout / 15 §2.4). The `scoped`
 * branch is deleted at S-V6 when the predicate becomes unconditional.
 *
 * The viewer is a REQUIRED parameter of every user-facing job list/get repository method — omission is a
 * compile error, not a review catch (10 §4.2 rule 1). Worker/system paths take no viewer (10 §4.3).
 */
export interface JobViewer {
  userId: string;
  role: WorkspaceRole;
  scoped: boolean;
}

/** Elevated workspace roles see every job in the workspace, with creator attribution (10 §2.1). */
export function isElevatedJobRole(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

// ── Creator attribution (10 §2.1 — "part of the contract, not garnish") ─────────────────────────────────
/**
 * The `createdBy` attribution carried on job list/detail rows when visibility scoping is active. `userId`
 * null = system/automation job (rendered "System"; visible to elevated roles only). `displayName` is the
 * creator's full name, falling back to email; null when the user row is gone (rendered "Former member").
 * OPTIONAL on every DTO: absent while the dual gate is off, so flag-off responses stay byte-identical.
 */
export const jobCreatedBySchema = z.object({
  userId: z.string().uuid().nullable(),
  displayName: z.string().nullable(),
});
export type JobCreatedBy = z.infer<typeof jobCreatedBySchema>;
