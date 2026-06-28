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
