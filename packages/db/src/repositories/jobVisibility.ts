// jobVisibility.ts — THE one job-visibility predicate (import-and-data-model-redesign 10 §4; the G01 fix).
// Applied INSIDE every user-facing job list/get repository method, never in routes: members see their own
// jobs (creator = viewer) plus explicitly shared rows; workspace admins/owners see everything in the
// workspace (RLS has already walled the workspace — `undefined` means "no FURTHER narrowing", never "no
// scoping"). The viewer is a REQUIRED parameter of every consumer signature, so a future surface that omits
// it fails to compile rather than ships leaking (10 §4.2 rule 1). Worker/system paths never call this —
// they read/mutate by jobId on their own scoped methods (10 §4.3).
//
// Rollout short-circuit (S-V3, deleted at S-V6): while the dual gate (JOB_VISIBILITY_SCOPED env kill-switch
// AND the per-tenant job_visibility_scoped flag) is off, `viewer.scoped` is false and the predicate degrades
// to workspace-wide — byte-identical shipped behavior (15 §2.4 flag-off byte-identity; T-V4).

import type { JobViewer } from "@leadwolf/types";
import { type AnyColumn, type SQL, eq, or } from "drizzle-orm";

/** The two job-row columns the predicate reads. Every job control table (import_jobs / reveal_jobs /
 *  enrichment_jobs) carries both: created_by_user_id (null = system/automation) + shared_with_workspace. */
export interface JobVisibilityColumns {
  createdByUserId: AnyColumn;
  sharedWithWorkspace: AnyColumn;
}

/**
 * The visibility narrowing for `viewer` over a job table, per the 10 §2.1 matrix:
 *   • gate off (`viewer.scoped` false)  → undefined — workspace-wide (legacy behavior, byte-identical);
 *   • elevated (owner/admin)            → undefined — all rows, with creator attribution at the read site;
 *   • member/viewer                     → creator-or-shared. System rows (created_by_user_id IS NULL) are
 *     nobody's "own", so they surface to elevated roles only (10 §Edge cases).
 * Compose into a WHERE with and(...) — drizzle's and() drops undefined terms.
 */
export function jobVisibility(viewer: JobViewer, cols: JobVisibilityColumns): SQL | undefined {
  if (!viewer.scoped) return undefined; // dual gate off — workspace-wide (T-V4 byte-identity)
  if (viewer.role === "owner" || viewer.role === "admin") return undefined; // all rows — RLS walls the ws
  return or(eq(cols.createdByUserId, viewer.userId), eq(cols.sharedWithWorkspace, true));
}

/**
 * The creator-only variant for provenance-derived surfaces with no share flag — today exactly
 * `source_imports.imported_by_user_id` behind the home Recent Imports card (10 §5 row 9). Same policy,
 * same short-circuit; there is no shared_with_workspace on provenance rows to widen by.
 */
export function creatorVisibility(viewer: JobViewer, createdByCol: AnyColumn): SQL | undefined {
  if (!viewer.scoped) return undefined;
  if (viewer.role === "owner" || viewer.role === "admin") return undefined;
  return eq(createdByCol, viewer.userId);
}

/**
 * The TIGHTEST gate — for the PII-bearing error artifacts (10 §2.1 last-but-one row, 13 §4.2): access is
 * creator ∪ elevated, and — unlike the list/detail predicate — `shared_with_workspace` is IGNORED (sharing
 * shares metadata, never artifacts) AND the dual-gate short-circuit is IGNORED (the artifact route is a NEW
 * endpoint, strict from birth regardless of the JOB_VISIBILITY_SCOPED flag — 10 §5 row 5 "none — new
 * endpoint"). Elevated ⇒ all rows in the (RLS-walled) workspace; everyone else ⇒ own rows only. The route
 * runs a member+ role gate first, so a viewer never reaches this; a non-creator member narrows to null ⇒ 404.
 */
export function artifactVisibility(viewer: JobViewer, createdByCol: AnyColumn): SQL | undefined {
  if (viewer.role === "owner" || viewer.role === "admin") return undefined;
  return eq(createdByCol, viewer.userId);
}
