// aiRequestRepository.ts — the metered AI-request log (M14 / 13a Area 14). create() appends one immutable row
// per model call (workspace-scoped write under RLS via withTenantTx). usageSince() is the PLATFORM read (owner
// connection — the caller opens withPlatformTx/withPlatformReadTx) that rolls up per-tenant AI volume,
// outcomes, latency + token totals since a cutoff, for staff AI observability. No PII is stored — the NL query
// text is never logged, only call metadata.

import { sql } from "drizzle-orm";
import { type Tx, withTenantTx } from "../client.ts";
import { aiRequests } from "../schema/aiRequests.ts";

export interface CreateAiRequestInput {
  /** The caller (claims.sub); null once the user is deleted (FK SET NULL). */
  userId: string | null;
  /** The AI task — today only "nl_search". */
  task: string;
  /** The configured model name at call time (nullable). */
  model: string | null;
  /** Outcome vocab (see @leadwolf/types aiRequestOutcome). */
  outcome: string;
  usedRepair: boolean;
  latencyMs: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/** One tenant's AI usage rollup over the window (platform observability). */
export interface AiUsageByTenant {
  tenantId: string;
  tenantName: string;
  requests: number;
  /** Non-"ok" outcomes (guard rejections + model/system failures). */
  failures: number;
  repairs: number;
  avgLatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
}

export const aiRequestRepository = {
  /** Append one metering row for a model call. Workspace-scoped (own tx unless one is supplied). */
  async create(
    scope: { tenantId: string; workspaceId: string },
    input: CreateAiRequestInput,
    tx?: Tx,
  ): Promise<void> {
    const run = async (t: Tx) => {
      await t.insert(aiRequests).values({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        userId: input.userId,
        task: input.task,
        model: input.model,
        outcome: input.outcome,
        usedRepair: input.usedRepair,
        latencyMs: input.latencyMs,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
      });
    };
    if (tx) return run(tx);
    await withTenantTx(scope, run);
  },

  /**
   * PLATFORM read (owner connection): per-tenant AI usage rollup since `sinceDays` ago, busiest first,
   * bounded by `limit`. Aggregates counts/outcomes/latency/tokens — no row-level PII.
   */
  async usageSince(tx: Tx, sinceDays: number, limit: number): Promise<AiUsageByTenant[]> {
    const rows = (await tx.execute(sql`
      SELECT t.id::text AS tenant_id, t.name AS tenant_name,
        COUNT(r.*)::int                                   AS requests,
        COUNT(r.*) FILTER (WHERE r.outcome <> 'ok')::int  AS failures,
        COUNT(r.*) FILTER (WHERE r.used_repair)::int      AS repairs,
        AVG(r.latency_ms)::float                          AS avg_latency_ms,
        COALESCE(SUM(r.input_tokens), 0)::int             AS input_tokens,
        COALESCE(SUM(r.output_tokens), 0)::int            AS output_tokens
      FROM ai_requests r
      JOIN tenants t ON t.id = r.tenant_id
      WHERE r.created_at >= now() - make_interval(days => ${sinceDays})
      GROUP BY t.id, t.name
      ORDER BY requests DESC, t.id
      LIMIT ${limit}
    `)) as unknown as Array<{
      tenant_id: string;
      tenant_name: string;
      requests: number;
      failures: number;
      repairs: number;
      avg_latency_ms: number | null;
      input_tokens: number;
      output_tokens: number;
    }>;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      requests: Number(r.requests),
      failures: Number(r.failures),
      repairs: Number(r.repairs),
      avgLatencyMs: r.avg_latency_ms === null ? null : Number(r.avg_latency_ms),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
    }));
  },
};
