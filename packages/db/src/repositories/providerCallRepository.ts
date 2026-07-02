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

  /** Serialize the daily-budget evaluation per workspace (re-audit F3 — worker-platform Phase 5 entry gate).
   *  The breaker used to be a racy read-check-act: N concurrent workers could each read `spendSince` below
   *  the budget before any of their costs committed, overshooting the daily cap by up to N paid calls. A
   *  TRANSACTION-scoped advisory lock taken before the read closes the race: the cost is recorded in the
   *  SAME tx (enrichContact), so the next holder sees every prior spend committed before its own check.
   *  Trade-off (documented in enrichContact): paid enrichment serializes per workspace — the effective
   *  posture anyway while the spend path runs concurrency 1 (tuning.ts F3); the ADR-0029 reservation-lease
   *  shape supersedes this when per-workspace parallel spend is actually wanted. xact-scoped ⇒ safe under
   *  transaction pooling; hashtext's int4 widens to the single-bigint-arg lock form. */
  async lockDailyBudget(tx: Tx, workspaceId: string): Promise<void> {
    await tx.execute(
      dsql`SELECT pg_advisory_xact_lock(hashtext(${`enrich_budget:${workspaceId}`}))`,
    );
  },

  /** Workspace spend since `since` — the input to the daily budget breaker (06 §6). */
  async spendSince(tx: Tx, workspaceId: string, since: Date): Promise<number> {
    const rows = await tx
      .select({ total: dsql<number>`coalesce(sum(${providerCalls.costMicros}), 0)::bigint` })
      .from(providerCalls)
      .where(and(eq(providerCalls.workspaceId, workspaceId), gte(providerCalls.calledAt, since)));
    return Number(rows[0]?.total ?? 0);
  },

  /**
   * The most recent enrichment calls for the Home dashboard, newest first. Workspace-scoped via RLS. Pass
   * `tx` to run on a caller's existing scoped transaction (e.g. the Home summary fan-out); omit it for a
   * standalone read.
   */
  async recentActivity(scope: TenantScope, limit = 5, tx?: Tx): Promise<EnrichActivityRow[]> {
    const run = (t: Tx): Promise<EnrichActivityRow[]> =>
      t
        .select({
          providerName: providerCalls.providerName,
          status: providerCalls.status,
          cacheHit: providerCalls.cacheHit,
          calledAt: providerCalls.calledAt,
        })
        .from(providerCalls)
        .orderBy(desc(providerCalls.calledAt))
        .limit(limit);
    return tx ? run(tx) : withTenantTx(scope, run);
  },
};
