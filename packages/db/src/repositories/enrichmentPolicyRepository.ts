// enrichmentPolicyRepository.ts — data access for the per-workspace auto-enrich policy (G-ENR-1; 29 §3,
// 06 §4.1). The ONLY place the `enrichment_policy` table is read/written. All paths run through
// withTenantTx (RLS workspace isolation). `get` returns the stored policy or null when unconfigured;
// `resolved` returns the stored policy or the off-by-default (so the single resolve-or-default mapping
// lives here, not duplicated across the API + core). `upsert` writes the full policy; `applyPartial`
// merges a partial onto the current policy and persists it in ONE transaction (read-merge-upsert) so two
// concurrent PATCHes can't lost-update. `monthlySpentMicros` delegates to providerCallRepository.spendSince
// (the single owner of the provider-spend aggregate SQL, 06 §6) with a month-start bound — the input to the
// monthly-budget cap the core guard enforces. The closed enums (EnrichTrigger / EnrichField) come from
// @leadwolf/types and narrow at the edge; the jsonb columns are widened arrays here.

import {
  DEFAULT_ENRICHMENT_POLICY,
  type EnrichField,
  type EnrichTrigger,
  type EnrichmentPolicy,
} from "@leadwolf/types";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { enrichmentPolicy } from "../schema/enrichmentPolicy.ts";
import { providerCallRepository } from "./providerCallRepository.ts";

/** The stored policy as read back (the jsonb arrays narrowed to their closed sets for the caller). */
export interface EnrichmentPolicyRecord {
  enabled: boolean;
  triggers: EnrichTrigger[];
  fieldAllowlist: EnrichField[];
  monthlyBudgetMicros: number;
  updatedAt: Date;
}

/** The writable policy columns. `tenantId`/`workspaceId` scope the row; the rest is the policy itself. */
export interface EnrichmentPolicyUpsert {
  tenantId: string;
  workspaceId: string;
  enabled: boolean;
  triggers: EnrichTrigger[];
  fieldAllowlist: EnrichField[];
  monthlyBudgetMicros: number;
}

/** A sparse policy patch — present fields replace, absent fields keep the current value (arrays replace whole). */
export type EnrichmentPolicyPatch = Partial<EnrichmentPolicy>;

/** First day of the current calendar month, UTC — the lower bound for month-to-date provider spend. */
function startOfUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The single mapping from a stored record to the resolved policy (used by `resolved` + `applyPartial`). */
function toPolicy(record: EnrichmentPolicyRecord): EnrichmentPolicy {
  return {
    enabled: record.enabled,
    triggers: record.triggers,
    fieldAllowlist: record.fieldAllowlist,
    monthlyBudgetMicros: record.monthlyBudgetMicros,
  };
}

/** Read the single policy row within an open tx (RLS-scoped). Null when the workspace has none. */
async function readRow(tx: Tx): Promise<EnrichmentPolicyRecord | null> {
  const rows = await tx
    .select({
      enabled: enrichmentPolicy.enabled,
      triggers: enrichmentPolicy.triggers,
      fieldAllowlist: enrichmentPolicy.fieldAllowlist,
      monthlyBudgetMicros: enrichmentPolicy.monthlyBudgetMicros,
      updatedAt: enrichmentPolicy.updatedAt,
    })
    .from(enrichmentPolicy)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    enabled: row.enabled,
    triggers: (row.triggers as EnrichTrigger[]) ?? [],
    fieldAllowlist: (row.fieldAllowlist as EnrichField[]) ?? [],
    monthlyBudgetMicros: Number(row.monthlyBudgetMicros),
    updatedAt: row.updatedAt,
  };
}

/** Insert-or-replace the policy within an open tx (ON CONFLICT on the workspace_id unique index → update). */
async function writeRow(tx: Tx, values: EnrichmentPolicyUpsert): Promise<EnrichmentPolicyRecord> {
  const rows = await tx
    .insert(enrichmentPolicy)
    .values({
      tenantId: values.tenantId,
      workspaceId: values.workspaceId,
      enabled: values.enabled,
      triggers: values.triggers,
      fieldAllowlist: values.fieldAllowlist,
      monthlyBudgetMicros: values.monthlyBudgetMicros,
    })
    .onConflictDoUpdate({
      target: enrichmentPolicy.workspaceId,
      set: {
        enabled: values.enabled,
        triggers: values.triggers,
        fieldAllowlist: values.fieldAllowlist,
        monthlyBudgetMicros: values.monthlyBudgetMicros,
      },
    })
    .returning({
      enabled: enrichmentPolicy.enabled,
      triggers: enrichmentPolicy.triggers,
      fieldAllowlist: enrichmentPolicy.fieldAllowlist,
      monthlyBudgetMicros: enrichmentPolicy.monthlyBudgetMicros,
      updatedAt: enrichmentPolicy.updatedAt,
    });
  const row = rows[0]!;
  return {
    enabled: row.enabled,
    triggers: (row.triggers as EnrichTrigger[]) ?? [],
    fieldAllowlist: (row.fieldAllowlist as EnrichField[]) ?? [],
    monthlyBudgetMicros: Number(row.monthlyBudgetMicros),
    updatedAt: row.updatedAt,
  };
}

export const enrichmentPolicyRepository = {
  /**
   * Read the workspace's auto-enrich policy. Null when none is configured — callers wanting the off-by-
   * default should use `resolved`. Workspace-scoped via RLS.
   */
  async get(scope: TenantScope): Promise<EnrichmentPolicyRecord | null> {
    return withTenantTx(scope, (tx) => readRow(tx));
  },

  /**
   * The resolved policy: the stored row, or DEFAULT_ENRICHMENT_POLICY (disabled) when the workspace has
   * none — so an unconfigured workspace never auto-enriches. The single resolve-or-default mapping.
   */
  async resolved(scope: TenantScope): Promise<EnrichmentPolicy> {
    return withTenantTx(scope, async (tx) => {
      const row = await readRow(tx);
      return row ? toPolicy(row) : DEFAULT_ENRICHMENT_POLICY;
    });
  },

  /**
   * Insert or replace the workspace's full policy in one statement. The `updated_at` trigger refreshes the
   * timestamp on the update branch. Workspace-scoped via RLS.
   */
  async upsert(
    scope: TenantScope,
    values: EnrichmentPolicyUpsert,
  ): Promise<EnrichmentPolicyRecord> {
    return withTenantTx(scope, (tx) => writeRow(tx, values));
  },

  /**
   * Merge a sparse patch onto the workspace's current policy (or the off-by-default) and persist it — all in
   * ONE transaction (read-merge-upsert) so two concurrent PATCHes can't lost-update. Present fields replace
   * (arrays replace whole); absent fields keep the current value. Returns the resolved policy after the write.
   */
  async applyPartial(
    scope: TenantScope,
    ids: { tenantId: string; workspaceId: string },
    patch: EnrichmentPolicyPatch,
  ): Promise<EnrichmentPolicyRecord> {
    return withTenantTx(scope, async (tx) => {
      const current = await readRow(tx);
      const base = current ? toPolicy(current) : DEFAULT_ENRICHMENT_POLICY;
      return writeRow(tx, {
        tenantId: ids.tenantId,
        workspaceId: ids.workspaceId,
        enabled: patch.enabled ?? base.enabled,
        triggers: patch.triggers ?? base.triggers,
        fieldAllowlist: patch.fieldAllowlist ?? base.fieldAllowlist,
        monthlyBudgetMicros: patch.monthlyBudgetMicros ?? base.monthlyBudgetMicros,
      });
    });
  },

  /**
   * Month-to-date provider spend for the workspace, in micros — the input to the monthly auto-enrich budget
   * cap (the core guard compares this against the policy's `monthlyBudgetMicros`). Delegates to
   * providerCallRepository.spendSince (the single owner of the provider-spend aggregate SQL, 06 §6) with a
   * UTC-month-start bound, so the monthly cap and the daily breaker can never disagree on how spend is summed.
   * Workspace-scoped via RLS.
   */
  async monthlySpentMicros(scope: TenantScope, now = new Date()): Promise<number> {
    if (!scope.workspaceId) throw new Error("monthlySpentMicros requires a workspaceId scope");
    const workspaceId = scope.workspaceId;
    return withTenantTx(scope, (tx) =>
      providerCallRepository.spendSince(tx, workspaceId, startOfUtcMonth(now)),
    );
  },
};
