// providerConfigRepository.ts — platform-admin provider settings (13 §3.6) + cross-tenant month-to-date
// spend. Mutations are upserts run INSIDE withPlatformTx (owner connection, audited). The MTD aggregation
// reads provider_calls ACROSS all tenants (the owner bypasses RLS), bounded to the current month and grouped
// in SQL (no per-tenant N+1). No secrets are touched — this only manages enable / budget / rate.

import { sql as dsql, gte } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { providerCalls, providerConfigs } from "../schema/intel.ts";

export interface ProviderConfigRow {
  provider: string;
  label: string;
  enabled: boolean;
  rateLimitPerMin: number | null;
  monthlyBudgetCents: number | null;
}

export const providerConfigRepository = {
  /** Every stored provider-config row (the supported provider set is small — no pagination needed). */
  async list(tx: Tx): Promise<ProviderConfigRow[]> {
    return tx
      .select({
        provider: providerConfigs.provider,
        label: providerConfigs.label,
        enabled: providerConfigs.enabled,
        rateLimitPerMin: providerConfigs.rateLimitPerMin,
        monthlyBudgetCents: providerConfigs.monthlyBudgetCents,
      })
      .from(providerConfigs);
  },

  /** Upsert a provider's enabled flag (label seeds the row on first write). */
  async upsertEnabled(tx: Tx, provider: string, label: string, enabled: boolean): Promise<void> {
    await tx
      .insert(providerConfigs)
      .values({ provider, label, enabled })
      .onConflictDoUpdate({
        target: providerConfigs.provider,
        set: { enabled, updatedAt: new Date() },
      });
  },

  /** Upsert a provider's monthly cost budget in cents (label seeds the row on first write). */
  async upsertBudget(
    tx: Tx,
    provider: string,
    label: string,
    monthlyBudgetCents: number,
  ): Promise<void> {
    await tx
      .insert(providerConfigs)
      .values({ provider, label, monthlyBudgetCents })
      .onConflictDoUpdate({
        target: providerConfigs.provider,
        set: { monthlyBudgetCents, updatedAt: new Date() },
      });
  },

  /**
   * Cross-tenant spend in CENTS per provider since `since` (cost is stored in micros; 10_000 micros = 1¢).
   * NOTE: provider_calls is FORCE-RLS workspace-scoped, so this cross-tenant sum only sees rows when the
   * withPlatformTx owner connection can bypass RLS (a superuser / BYPASSRLS owner — true on the single
   * Postgres deploy + CI). On a managed non-superuser owner (e.g. Neon) it returns 0 until a platform-level
   * spend rollup lands; the console renders that as $0 month-to-date, never an error.
   */
  async monthToDateCentsByProvider(tx: Tx, since: Date): Promise<Record<string, number>> {
    const rows = await tx
      .select({
        provider: providerCalls.providerName,
        micros: dsql<number>`coalesce(sum(${providerCalls.costMicros}), 0)::bigint`,
      })
      .from(providerCalls)
      .where(gte(providerCalls.calledAt, since))
      .groupBy(providerCalls.providerName);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.provider.toLowerCase()] = Math.round(Number(r.micros) / 10_000);
    return out;
  },
};
