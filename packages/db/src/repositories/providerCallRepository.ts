// providerCallRepository.ts — the enrichment cache + cost ledger (enrichment domain, 06 §5/§6). One row
// per (workspace, request_hash, provider) attempt: hit rows are the persistent cache (short-circuit the
// waterfall with no call and no cost); every row's cost_micros aggregates into the daily budget breaker.
// Pre-0111 the unique was (workspace, request_hash) only, which silently dropped every attempt after the
// first — see the defect note on the index in schema/intel.ts.

import type { EnrichField } from "@leadwolf/types";
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
  /** The fields THIS call filled (waterfall v2 per-field cache). Omit on legacy/whole-request rows. */
  filledFields?: EnrichField[];
  /** Provider round-trip in ms — the 06 §4 telemetry input. */
  latencyMs?: number;
  /** Verify-before-accept verdicts for values this call supplied, e.g. {email: {status, verifier}}. */
  verification?: unknown;
}

export interface CachedCall {
  providerName: string;
  responsePayload: unknown;
}

/** One cached hit row of a per-field cache read (waterfall v2). */
export interface CachedFieldHit {
  providerName: string;
  responsePayload: unknown;
  /** null = a legacy (pre-0111) row that covered the WHOLE request. */
  filledFields: EnrichField[] | null;
}

export interface CachedFieldsResult {
  /** "all" when a legacy whole-request hit exists; otherwise the union of per-field coverage. */
  coveredFields: EnrichField[] | "all";
  byProvider: CachedFieldHit[];
  /**
   * Providers that ANSWERED this request (a hit or a PAID miss). Every call is made with the union of
   * still-unfilled fields, so an answered provider was already asked for everything a retry would ask —
   * the engine skips these to never pay the same vendor twice for one request. rate_limited/error rows
   * are NOT included (those deserve a retry, and their zero-cost rows upgrade in place on success).
   */
  answeredProviders: string[];
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

  /**
   * Record a call outcome. Conflict semantics on the (workspace, request_hash, provider) triple:
   *   • existing row is a PAID answer (hit/miss) → no-op — concurrent duplicates collapse, and a paid
   *     ledger row is never mutated;
   *   • existing row is a ZERO-COST non-answer (rate_limited/error) → UPGRADE in place — a later retry
   *     that gets through must not have its paid row silently dropped (the 0111 defect's retry-shaped
   *     sibling). Cost is summed (the old row's is 0 by construction), payload/fields/status replaced.
   */
  async record(tx: Tx, call: ProviderCallRecord): Promise<void> {
    await tx
      .insert(providerCalls)
      .values({ ...call, cacheHit: call.cacheHit ?? false })
      .onConflictDoUpdate({
        target: [providerCalls.workspaceId, providerCalls.requestHash, providerCalls.providerName],
        set: {
          status: dsql`excluded.status`,
          costMicros: dsql`${providerCalls.costMicros} + excluded.cost_micros`,
          responsePayload: dsql`excluded.response_payload`,
          filledFields: dsql`excluded.filled_fields`,
          latencyMs: dsql`excluded.latency_ms`,
          verification: dsql`excluded.verification`,
          calledAt: dsql`excluded.called_at`,
        },
        setWhere: dsql`${providerCalls.status} IN ('rate_limited','error')`,
      });
  },

  /**
   * Per-field cache read (waterfall v2): every persisted hit for this request, with the fields each hit
   * covered. A legacy row (null filled_fields, written before 0111) covered the whole request — callers
   * treat it as "all" so old cache entries keep short-circuiting exactly as they always did.
   */
  async findCachedFields(
    tx: Tx,
    workspaceId: string,
    requestHash: Uint8Array,
  ): Promise<CachedFieldsResult> {
    const rows = await tx
      .select({
        providerName: providerCalls.providerName,
        responsePayload: providerCalls.responsePayload,
        filledFields: providerCalls.filledFields,
        status: providerCalls.status,
      })
      .from(providerCalls)
      .where(
        and(eq(providerCalls.workspaceId, workspaceId), eq(providerCalls.requestHash, requestHash)),
      );
    const answeredProviders = rows
      .filter((r) => r.status === "hit" || r.status === "miss")
      .map((r) => r.providerName);
    const hits = rows.filter((r) => r.status === "hit");
    const byProvider: CachedFieldHit[] = hits.map((r) => ({
      providerName: r.providerName,
      responsePayload: r.responsePayload,
      filledFields: (r.filledFields as EnrichField[] | null) ?? null,
    }));
    if (byProvider.some((r) => r.filledFields === null)) {
      return { coveredFields: "all", byProvider, answeredProviders };
    }
    const union = new Set<EnrichField>();
    for (const row of byProvider) for (const f of row.filledFields ?? []) union.add(f);
    return { coveredFields: [...union], byProvider, answeredProviders };
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

  /** Workspace spend since `since`, split by provider — the admin/stats read (06 §4 telemetry). */
  async spendSinceByProvider(
    tx: Tx,
    workspaceId: string,
    since: Date,
  ): Promise<Array<{ providerName: string; totalMicros: number }>> {
    const rows = await tx
      .select({
        providerName: providerCalls.providerName,
        totalMicros: dsql<number>`coalesce(sum(${providerCalls.costMicros}), 0)::bigint`,
      })
      .from(providerCalls)
      .where(and(eq(providerCalls.workspaceId, workspaceId), gte(providerCalls.calledAt, since)))
      .groupBy(providerCalls.providerName);
    return rows.map((r) => ({ providerName: r.providerName, totalMicros: Number(r.totalMicros) }));
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
