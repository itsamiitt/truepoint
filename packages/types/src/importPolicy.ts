// importPolicy.ts — the per-workspace import policy contract (import-and-data-model-redesign 10 §3, S-V1;
// the G02 "import at all" grant). Single source of truth shared by apps/api (the admin-gated settings
// endpoint + the create-grant enforcement) and apps/web (the settings panel + disabled-with-reason states).
// One row per workspace mirroring the enrichment_policy idiom: `whoCanImport` is the grant escape hatch
// (default 'member' — HubSpot-like broad default; 'admin' — Outreach-like governed default), and the two
// strategy defaults are 08 §5's org-admin workspace defaults (consumed by the S-I6 engines later).

import { z } from "zod";

// ── Vocabulary ───────────────────────────────────────────────────────────────────────────────────────────
/** Who may create imports in the workspace: 'member' = member+ (the default), 'admin' = elevated only. */
export const whoCanImport = z.enum(["member", "admin"]);
export type WhoCanImport = z.infer<typeof whoCanImport>;

/** The 08 §5 merge-strategy triad (workspace default; per-import override lands with S-I6). */
export const importMergeMode = z.enum(["create_and_update", "create_only", "update_only"]);
export type ImportMergeMode = z.infer<typeof importMergeMode>;

// ── The policy (the full, resolved shape the API returns and the create-gate reads) ─────────────────────
export const importPolicySchema = z.object({
  whoCanImport: whoCanImport,
  defaultMergeMode: importMergeMode,
  defaultPreservePopulated: z.boolean(),
});
export type ImportPolicy = z.infer<typeof importPolicySchema>;

/** The PUT body for the settings endpoint — every field optional so an admin can flip one knob without
 *  resending the whole policy. Empty object is a valid no-op. */
export const updateImportPolicySchema = z
  .object({
    whoCanImport: whoCanImport,
    defaultMergeMode: importMergeMode,
    defaultPreservePopulated: z.boolean(),
  })
  .partial();
export type UpdateImportPolicy = z.infer<typeof updateImportPolicySchema>;

/** The GET/PUT response: the resolved policy + when/by whom it was last changed (null = never user-set). */
export const importPolicyResponseSchema = importPolicySchema.extend({
  updatedByUserId: z.string().uuid().nullable(),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ImportPolicyResponse = z.infer<typeof importPolicyResponseSchema>;

// ── Default (an unconfigured workspace behaves exactly like today's member-broad posture) ────────────────
export const DEFAULT_IMPORT_POLICY: ImportPolicy = {
  whoCanImport: "member",
  defaultMergeMode: "create_and_update",
  defaultPreservePopulated: false,
};
