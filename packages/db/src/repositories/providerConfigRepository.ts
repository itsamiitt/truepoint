// providerConfigRepository.ts — platform-admin provider settings (13 §3.6) + cross-tenant month-to-date
// spend. Mutations are upserts run INSIDE withPlatformTx (owner connection, audited). The MTD aggregation
// reads provider_calls ACROSS all tenants (the owner bypasses RLS), bounded to the current month and grouped
// in SQL (no per-tenant N+1). No secrets are touched — this only manages enable / budget / rate.

import type { ProviderCallStatusCounts, ProviderWaterfallStats } from "@leadwolf/types";
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

  /**
   * The configs the WATERFALL reads on a tenant tx (waterfall v2 / D8): global platform config, app role
   * may SELECT (rls/providerConfigs.sql — read-true policy, no write policy). A provider with no row is
   * implicitly enabled (default-true column semantics); rows with enabled=false are excluded from every
   * run; rate/budget feed the ProviderGate.
   */
  async listEnabled(tx: Tx): Promise<ProviderConfigRow[]> {
    const rows = await providerConfigRepository.list(tx);
    return rows.filter((r) => r.enabled);
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

  /**
   * Cross-tenant recent call-STATUS counts per provider since `since` — the raw signal for PASSIVE provider
   * health (turned into a status by @leadwolf/types deriveProviderHealth). Same owner/cross-tenant path as
   * monthToDateCentsByProvider: grouped in SQL by (provider_name, status) so the result is tiny
   * (providers × statuses) and bounded by the time window. Selects ONLY provider_name/status/count — NEVER
   * response_payload (no PII, no secrets). Same BYPASSRLS caveat applies: on a non-superuser owner it sees
   * no rows, so every provider reads back as "unknown" (never a fabricated green).
   */
  /**
   * Cross-tenant waterfall telemetry per provider since `since` (0109, P6): attempts / hits /
   * verified-valid / latency avg+p95 / total cost — the read-only substrate for 06 §4's expectedHitRate
   * learning. Verification rows (`verify:%` names) are EXCLUDED — they meter the verifier, not a vendor.
   * Selects aggregates only, never response_payload. Same BYPASSRLS caveat as the reads above: on a
   * non-superuser owner it sees no rows and every provider reads back null stats (never fabricated zeros).
   */
  async waterfallStatsByProvider(
    tx: Tx,
    since: Date,
    windowDays: number,
  ): Promise<Record<string, ProviderWaterfallStats>> {
    const rows = (await tx.execute(dsql`
      SELECT provider_name,
             count(*)::int                                                        AS attempts,
             (count(*) FILTER (WHERE status = 'hit'))::int                        AS hits,
             (count(*) FILTER (
                WHERE status = 'hit'
                  AND verification -> 'email' ->> 'status' = 'valid'))::int       AS verified_valid,
             avg(latency_ms)::float8                                              AS avg_latency_ms,
             (percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::float8   AS p95_latency_ms,
             coalesce(sum(cost_micros), 0)::bigint                                AS total_cost_micros
      FROM provider_calls
      WHERE called_at >= ${since}
        AND provider_name NOT LIKE 'verify:%'
      GROUP BY provider_name
    `)) as unknown as Array<{
      provider_name: string;
      attempts: number;
      hits: number;
      verified_valid: number;
      avg_latency_ms: number | null;
      p95_latency_ms: number | null;
      total_cost_micros: string | number;
    }>;
    const out: Record<string, ProviderWaterfallStats> = {};
    for (const r of rows) {
      const attempts = Number(r.attempts);
      const hits = Number(r.hits);
      const verifiedValid = Number(r.verified_valid);
      const totalCostMicros = Number(r.total_cost_micros);
      out[r.provider_name.toLowerCase()] = {
        windowDays,
        attempts,
        hits,
        hitRate: attempts > 0 ? hits / attempts : null,
        verifiedValid,
        verifiedValidRate: hits > 0 ? verifiedValid / hits : null,
        avgLatencyMs: r.avg_latency_ms == null ? null : Number(r.avg_latency_ms),
        p95LatencyMs: r.p95_latency_ms == null ? null : Number(r.p95_latency_ms),
        totalCostMicros,
        costPerVerifiedValidMicros:
          verifiedValid > 0 ? Math.round(totalCostMicros / verifiedValid) : null,
      };
    }
    return out;
  },

  async recentHealthByProvider(
    tx: Tx,
    since: Date,
  ): Promise<Record<string, ProviderCallStatusCounts>> {
    const rows = await tx
      .select({
        provider: providerCalls.providerName,
        status: providerCalls.status,
        count: dsql<number>`count(*)::bigint`,
      })
      .from(providerCalls)
      .where(gte(providerCalls.calledAt, since))
      .groupBy(providerCalls.providerName, providerCalls.status);
    const out: Record<string, ProviderCallStatusCounts> = {};
    for (const r of rows) {
      const key = r.provider.toLowerCase();
      out[key] ??= { hit: 0, miss: 0, rateLimited: 0, error: 0 };
      const bucket = out[key];
      const n = Number(r.count);
      if (r.status === "hit") bucket.hit = n;
      else if (r.status === "miss") bucket.miss = n;
      else if (r.status === "rate_limited") bucket.rateLimited = n;
      else if (r.status === "error") bucket.error = n;
    }
    return out;
  },
};
