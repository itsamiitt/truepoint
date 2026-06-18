// featureFlagRepository.ts — the ONLY data-access for the platform feature-flag tables (13 §3.5, ADR-0011).
// Two readers used by different callers:
//   • evaluation reads (flagsForTenant / globalFlags) — run inside the caller's transaction. Under
//     withTenantTx (leadwolf_app) RLS already restricts tenant_feature_flags to the active tenant and
//     exposes the read-only global feature_flags; under withPlatformTx (owner) they see everything.
//   • admin writes (upsert / setGlobal / setTenantOverride / clearTenantOverride) — MUST run inside
//     withPlatformTx (owner role), which both audits the action and bypasses the app-role write-deny RLS.
// No method opens its own transaction; the caller chooses the privileged/scoped path.

import { and, eq } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { featureFlags, tenantFeatureFlags } from "../schema/featureFlags.ts";

/** A global flag definition row (camelCase column projection). */
export interface FeatureFlagRecord {
  key: string;
  description: string | null;
  globalEnabled: boolean;
  defaultEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A per-tenant override row. */
export interface TenantFeatureFlagRecord {
  flagKey: string;
  tenantId: string;
  enabled: boolean;
}

export interface FeatureFlagUpsertValues {
  key: string;
  description?: string | null;
  globalEnabled?: boolean;
  defaultEnabled?: boolean;
}

export const featureFlagRepository = {
  /** All global flag definitions, newest-defined first. Read path (any tx). */
  async listGlobal(tx: Tx): Promise<FeatureFlagRecord[]> {
    return tx
      .select({
        key: featureFlags.key,
        description: featureFlags.description,
        globalEnabled: featureFlags.globalEnabled,
        defaultEnabled: featureFlags.defaultEnabled,
        createdAt: featureFlags.createdAt,
        updatedAt: featureFlags.updatedAt,
      })
      .from(featureFlags)
      .orderBy(featureFlags.key);
  },

  /** A single global flag by key, or null. */
  async getGlobal(tx: Tx, key: string): Promise<FeatureFlagRecord | null> {
    const rows = await tx
      .select({
        key: featureFlags.key,
        description: featureFlags.description,
        globalEnabled: featureFlags.globalEnabled,
        defaultEnabled: featureFlags.defaultEnabled,
        createdAt: featureFlags.createdAt,
        updatedAt: featureFlags.updatedAt,
      })
      .from(featureFlags)
      .where(eq(featureFlags.key, key))
      .limit(1);
    return rows[0] ?? null;
  },

  /** All overrides for a tenant. Under withTenantTx RLS already restricts to the active tenant; the
   *  explicit predicate keeps the privileged (owner) path correct too. */
  async overridesForTenant(tx: Tx, tenantId: string): Promise<TenantFeatureFlagRecord[]> {
    return tx
      .select({
        flagKey: tenantFeatureFlags.flagKey,
        tenantId: tenantFeatureFlags.tenantId,
        enabled: tenantFeatureFlags.enabled,
      })
      .from(tenantFeatureFlags)
      .where(eq(tenantFeatureFlags.tenantId, tenantId));
  },

  /** A single (flagKey, tenantId) override via the composite PK, or null — the cheap single-flag gate path.
   *  Under withTenantTx RLS still restricts to the active tenant; the explicit predicate is the PK lookup. */
  async overrideFor(tx: Tx, flagKey: string, tenantId: string): Promise<boolean | null> {
    const rows = await tx
      .select({ enabled: tenantFeatureFlags.enabled })
      .from(tenantFeatureFlags)
      .where(
        and(eq(tenantFeatureFlags.flagKey, flagKey), eq(tenantFeatureFlags.tenantId, tenantId)),
      )
      .limit(1);
    return rows[0]?.enabled ?? null;
  },

  /** Every override for a flag (admin detail view). Privileged path only (cross-tenant). */
  async overridesForFlag(tx: Tx, flagKey: string): Promise<TenantFeatureFlagRecord[]> {
    return tx
      .select({
        flagKey: tenantFeatureFlags.flagKey,
        tenantId: tenantFeatureFlags.tenantId,
        enabled: tenantFeatureFlags.enabled,
      })
      .from(tenantFeatureFlags)
      .where(eq(tenantFeatureFlags.flagKey, flagKey));
  },

  /** ALL overrides across all flags — the single-query source for the admin list (avoids an N+1 of
   *  overridesForFlag per flag). Privileged (cross-tenant) path only. */
  async allOverrides(tx: Tx): Promise<TenantFeatureFlagRecord[]> {
    return tx
      .select({
        flagKey: tenantFeatureFlags.flagKey,
        tenantId: tenantFeatureFlags.tenantId,
        enabled: tenantFeatureFlags.enabled,
      })
      .from(tenantFeatureFlags);
  },

  // ── Writes — privileged (withPlatformTx) only. ───────────────────────────────────────────────────────
  /** Define or update a flag (idempotent on key). Touches updatedAt. */
  async upsert(tx: Tx, values: FeatureFlagUpsertValues): Promise<void> {
    const insert: typeof featureFlags.$inferInsert = { key: values.key };
    if (values.description !== undefined) insert.description = values.description;
    if (values.globalEnabled !== undefined) insert.globalEnabled = values.globalEnabled;
    if (values.defaultEnabled !== undefined) insert.defaultEnabled = values.defaultEnabled;

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (values.description !== undefined) set.description = values.description;
    if (values.globalEnabled !== undefined) set.globalEnabled = values.globalEnabled;
    if (values.defaultEnabled !== undefined) set.defaultEnabled = values.defaultEnabled;

    await tx.insert(featureFlags).values(insert).onConflictDoUpdate({
      target: featureFlags.key,
      set,
    });
  },

  /** Toggle a flag's global_enabled. Returns false if no such flag. */
  async setGlobal(tx: Tx, key: string, enabled: boolean): Promise<boolean> {
    const rows = await tx
      .update(featureFlags)
      .set({ globalEnabled: enabled, updatedAt: new Date() })
      .where(eq(featureFlags.key, key))
      .returning({ key: featureFlags.key });
    return rows.length > 0;
  },

  /** Set (upsert) a per-tenant override. */
  async setTenantOverride(
    tx: Tx,
    flagKey: string,
    tenantId: string,
    enabled: boolean,
  ): Promise<void> {
    await tx
      .insert(tenantFeatureFlags)
      .values({ flagKey, tenantId, enabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [tenantFeatureFlags.flagKey, tenantFeatureFlags.tenantId],
        set: { enabled, updatedAt: new Date() },
      });
  },

  /** Clear a per-tenant override (falls back to global/default thereafter). */
  async clearTenantOverride(tx: Tx, flagKey: string, tenantId: string): Promise<void> {
    await tx
      .delete(tenantFeatureFlags)
      .where(
        and(eq(tenantFeatureFlags.flagKey, flagKey), eq(tenantFeatureFlags.tenantId, tenantId)),
      );
  },
};
