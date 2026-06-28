// types.ts — view-model types for the global retention-policy admin slice (data-management A2). The policy
// shape itself is the SHARED contract from @leadwolf/types (the single source of truth shared with the db
// repository + the sweep); this file just re-exports it for local imports and names the writable patch the
// EditPolicyDialog edits (the mutable fields — dataClass identifies the row and is not edited).

export type {
  RetentionPolicy,
  RetentionMode,
  RetentionDataClass,
} from "@leadwolf/types";
import type { RetentionMode } from "@leadwolf/types";

/** The mutable fields of a policy (what the edit dialog changes). `ttlDays` null = never auto-delete. */
export interface RetentionPolicyPatch {
  ttlDays: number | null;
  mode: RetentionMode;
}

/** One cross-tenant retention RUN as the admin Runs panel renders it (data-management A5) — mirrors the api
 *  `/admin/retention-runs` payload (backed by @leadwolf/db platformAdminReads.recentRetentionRuns). COUNTS +
 *  class + window only — retention_runs carries no contact PII. Dates arrive as ISO strings (c.json serializes
 *  the repo's Date columns); `cutoff` is null when the class never ages out. The api owns the canonical shape. */
export interface RetentionRunRow {
  tenantId: string;
  tenantName: string;
  dataClass: string;
  mode: string;
  candidateCount: number;
  deletedCount: number;
  cutoff: string | null;
  runStartedAt: string;
  runFinishedAt: string;
}
