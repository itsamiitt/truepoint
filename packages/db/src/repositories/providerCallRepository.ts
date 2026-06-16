// providerCallRepository.ts — the enrichment cache + cost ledger (enrichment domain, 06 §5/§6). The
// unique (workspace, request_hash) row is the persistent cache: a hit short-circuits the waterfall with
// no call and no cost; cost_micros aggregates into the daily budget breaker.

import { and, desc, sql as dsql, eq, gte } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { providerCalls } from "../schema/intel.ts";

/** One recent enrichment call for the Home dashboard (provider, outcome, cache hit, time). */
export interface EnrichActivityRow {
  providerName: string;
  status: string;
  cacheHit: boolean;
  calledAt: Date;
}

export interface ProviderCallRecord {
  tenantId: string;
  workspaceId: string;
  providerName: string;
  requestHash: Uint8Array;
  status: "hit" | "miss" | "rate_limited" | "error";
  costMicros: number;
  cacheHit?: boolean;
  responsePayload?: unknown;
}

export interface CachedCall {
  providerName: string;
  responsePayload: unknown;
}

export const providerCallRepository = {
  /** Cached successful answer for this normalized request, if any (06 §5: never pay twice). */
  async findCached(
    tx: Tx,
    workspaceId: string,
    requestHash: Uint8Array,
  ): Promise<CachedCall | null> {
    const rows = await tx
      .select({
        providerName: providerCalls.providerName,
        responsePayload: providerCalls.responsePayload,
      })
      .from(providerCalls)
      .where(
        and(
          eq(providerCalls.workspaceId, workspaceId),
          eq(providerCalls.requestHash, requestHash),
          eq(providerCalls.status, "hit"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Record a call outcome; a concurrent duplicate of the same request is a silent no-op (unique index). */
  async record(tx: Tx, call: ProviderCallRecord): Promise<void> {
    await tx
      .insert(providerCalls)
      .values({ ...call, cacheHit: call.cacheHit ?? false })
      .onConflictDoNothing();
  },

  /** Workspace spend since `since` — the input to the daily budget breaker (06 §6). */
  async spendSince(tx: Tx, workspaceId: string, since: Date): Promise<number> {
    const rows = await tx
      .select({ total: dsql<number>`coalesce(sum(${providerCalls.costMicros}), 0)::bigint` })
      .from(providerCalls)
      .where(and(eq(providerCalls.workspaceId, workspaceId), gte(providerCalls.calledAt, since)));
    return Number(rows[0]?.total ?? 0);
  },

  /** The most recent enrichment calls for the Home dashboard, newest first. Workspace-scoped via RLS. */
  async recentActivity(scope: TenantScope, limit = 5): Promise<EnrichActivityRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          providerName: providerCalls.providerName,
          status: providerCalls.status,
          cacheHit: providerCalls.cacheHit,
          calledAt: providerCalls.calledAt,
        })
        .from(providerCalls)
        .orderBy(desc(providerCalls.calledAt))
        .limit(limit),
    );
  },
};
