// importPolicyRepository.ts — data access for the per-workspace import policy (import-and-data-model-
// redesign 10 §3, S-V4; G02). The ONLY place the `import_policy` table is read/written. Mirrors
// enrichmentPolicyRepository: `get` returns the stored policy or null; `resolved` returns the stored policy
// or DEFAULT_IMPORT_POLICY (whoCanImport 'member' — an unconfigured workspace behaves exactly like today's
// member-broad posture); `upsertInTx` is TX-AWARE so the settings PUT composes the write and its
// `import.policy_updated` audit row in ONE transaction (in-tx audit discipline — they commit or roll back
// together). All scoped paths ride withTenantTx / the caller's scoped tx (RLS workspace isolation under the
// non-BYPASSRLS leadwolf_app role; the workspace_id unique index is the upsert target).

import {
  DEFAULT_IMPORT_POLICY,
  type ImportMergeMode,
  type ImportPolicy,
  type WhoCanImport,
} from "@leadwolf/types";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { importPolicy } from "../schema/importPolicy.ts";

/** The stored policy as read back (closed vocabularies narrowed for the caller). */
export interface ImportPolicyRecord {
  whoCanImport: WhoCanImport;
  defaultMergeMode: ImportMergeMode;
  defaultPreservePopulated: boolean;
  updatedByUserId: string | null;
  updatedAt: Date;
}

/** The writable policy columns. `tenantId`/`workspaceId` scope the row; `updatedByUserId` records the
 *  acting admin (from the VERIFIED token — never the body). */
export interface ImportPolicyUpsert {
  tenantId: string;
  workspaceId: string;
  whoCanImport: WhoCanImport;
  defaultMergeMode: ImportMergeMode;
  defaultPreservePopulated: boolean;
  updatedByUserId: string;
}

const RECORD_COLUMNS = {
  whoCanImport: importPolicy.whoCanImport,
  defaultMergeMode: importPolicy.defaultMergeMode,
  defaultPreservePopulated: importPolicy.defaultPreservePopulated,
  updatedByUserId: importPolicy.updatedByUserId,
  updatedAt: importPolicy.updatedAt,
} as const;

function toRecord(row: {
  whoCanImport: string;
  defaultMergeMode: string;
  defaultPreservePopulated: boolean;
  updatedByUserId: string | null;
  updatedAt: Date;
}): ImportPolicyRecord {
  return {
    whoCanImport: row.whoCanImport as WhoCanImport,
    defaultMergeMode: row.defaultMergeMode as ImportMergeMode,
    defaultPreservePopulated: row.defaultPreservePopulated,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  };
}

/** Read the single policy row within an open scoped tx (RLS confines it to the caller's workspace). */
async function readRow(tx: Tx): Promise<ImportPolicyRecord | null> {
  const rows = await tx.select(RECORD_COLUMNS).from(importPolicy).limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
}

export const importPolicyRepository = {
  /** The stored policy, or null when the workspace never configured one. Workspace-scoped via RLS. */
  async get(scope: TenantScope): Promise<ImportPolicyRecord | null> {
    return withTenantTx(scope, (tx) => readRow(tx));
  },

  /** Tx-aware read for callers composing inside an open scoped tx (the settings PUT's read-merge step). */
  async getInTx(tx: Tx): Promise<ImportPolicyRecord | null> {
    return readRow(tx);
  },

  /**
   * The resolved policy: the stored row, or DEFAULT_IMPORT_POLICY when the workspace has none — so an
   * unconfigured workspace keeps the member-broad default posture. The single resolve-or-default mapping;
   * the create-grant enforcement reads THIS (never the raw row).
   */
  async resolved(scope: TenantScope): Promise<ImportPolicy> {
    return withTenantTx(scope, async (tx) => {
      const row = await readRow(tx);
      return row
        ? {
            whoCanImport: row.whoCanImport,
            defaultMergeMode: row.defaultMergeMode,
            defaultPreservePopulated: row.defaultPreservePopulated,
          }
        : DEFAULT_IMPORT_POLICY;
    });
  },

  /**
   * Insert-or-replace the workspace's policy within the CALLER's open scoped tx (ON CONFLICT on the
   * workspace_id unique index → update; the `updated_at` trigger refreshes the timestamp). TX-AWARE by
   * design: the settings PUT writes the policy AND its `import.policy_updated` audit row in the same
   * transaction, so a policy change without its audit trail cannot commit (T-V6).
   */
  async upsertInTx(tx: Tx, values: ImportPolicyUpsert): Promise<ImportPolicyRecord> {
    const rows = await tx
      .insert(importPolicy)
      .values({
        tenantId: values.tenantId,
        workspaceId: values.workspaceId,
        whoCanImport: values.whoCanImport,
        defaultMergeMode: values.defaultMergeMode,
        defaultPreservePopulated: values.defaultPreservePopulated,
        updatedByUserId: values.updatedByUserId,
      })
      .onConflictDoUpdate({
        target: importPolicy.workspaceId,
        set: {
          whoCanImport: values.whoCanImport,
          defaultMergeMode: values.defaultMergeMode,
          defaultPreservePopulated: values.defaultPreservePopulated,
          updatedByUserId: values.updatedByUserId,
        },
      })
      .returning(RECORD_COLUMNS);
    return toRecord(rows[0]!);
  },
};
