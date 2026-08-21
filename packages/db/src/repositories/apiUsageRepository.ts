// apiUsageRepository.ts — record and read public-API usage (ADR-0049). Two operations with opposite shapes:
// a hot per-call UPSERT on the API path, and a bounded windowed read for the customer dashboard.
//
// Both run under withTenantTx as leadwolf_app, so RLS supplies the tenant predicate. The reads carry an
// explicit tenant filter anyway, as defence-in-depth — the house convention everywhere else in this folder.

import { and, desc, eq, gte, sql, sum } from "drizzle-orm";
import { withTenantTx } from "../client.ts";
import { apiKeyUsageDaily } from "../schema/apiKeys.ts";

/** One (key, day, endpoint) bucket as the dashboard reads it. */
export interface ApiUsageDayRow {
  day: string;
  endpoint: string;
  apiKeyId: string;
  calls: number;
  billedCalls: number;
  creditsSpent: number;
}

export interface ApiUsageTotals {
  calls: number;
  billedCalls: number;
  creditsSpent: number;
}

export const apiUsageRepository = {
  /**
   * Count one API call against its key/day/endpoint bucket.
   *
   * MUST run inside the caller's tenant transaction — it takes a `tx` rather than opening its own so the
   * counter moves in the SAME transaction as the credit spend it describes. Metering that commits separately
   * from the charge is metering that disagrees with the invoice.
   *
   * `billed` and `credits` are 0 for a no-match: the call still happened and is still counted, which is what
   * makes the no-match rate visible to the customer instead of being silently dropped.
   *
   * The upsert is the whole design — one round trip, no read-modify-write, and safe under concurrency because
   * the increment happens inside the database rather than in application memory.
   */
  async record(
    tx: Parameters<Parameters<typeof withTenantTx>[1]>[0],
    input: {
      tenantId: string;
      workspaceId: string;
      apiKeyId: string;
      endpoint: string;
      billed: boolean;
      credits: number;
    },
  ): Promise<void> {
    const { tenantId, workspaceId, apiKeyId, endpoint, billed, credits } = input;
    await tx
      .insert(apiKeyUsageDaily)
      .values({
        tenantId,
        workspaceId,
        apiKeyId,
        // The bucket is a calendar day in UTC. The dashboard re-buckets for display if it ever needs a
        // tenant timezone; storing in one fixed zone keeps the primary key stable.
        day: sql`(now() AT TIME ZONE 'utc')::date`,
        endpoint,
        calls: 1,
        billedCalls: billed ? 1 : 0,
        creditsSpent: credits,
      })
      .onConflictDoUpdate({
        target: [
          apiKeyUsageDaily.tenantId,
          apiKeyUsageDaily.apiKeyId,
          apiKeyUsageDaily.day,
          apiKeyUsageDaily.endpoint,
        ],
        set: {
          calls: sql`${apiKeyUsageDaily.calls} + 1`,
          billedCalls: sql`${apiKeyUsageDaily.billedCalls} + ${billed ? 1 : 0}`,
          creditsSpent: sql`${apiKeyUsageDaily.creditsSpent} + ${credits}`,
        },
      });
  },

  /**
   * The dashboard read: every bucket in the last `days`, newest first. Bounded by construction — the rollup
   * means this returns at most (keys × endpoints × days) rows, so there is no pagination and no cap to get
   * wrong. A tenant with five keys and four endpoints over 30 days tops out at 600 rows.
   */
  async recentForTenant(tenantId: string, days: number): Promise<ApiUsageDayRow[]> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select({
          day: apiKeyUsageDaily.day,
          endpoint: apiKeyUsageDaily.endpoint,
          apiKeyId: apiKeyUsageDaily.apiKeyId,
          calls: apiKeyUsageDaily.calls,
          billedCalls: apiKeyUsageDaily.billedCalls,
          creditsSpent: apiKeyUsageDaily.creditsSpent,
        })
        .from(apiKeyUsageDaily)
        .where(
          and(
            eq(apiKeyUsageDaily.tenantId, tenantId),
            gte(apiKeyUsageDaily.day, sql`(now() AT TIME ZONE 'utc')::date - ${days}::int`),
          ),
        )
        .orderBy(desc(apiKeyUsageDaily.day));
      return rows.map((r) => ({ ...r, day: String(r.day) }));
    });
  },

  /** Window totals, summed in the database rather than over a fetched page. */
  async totalsForTenant(tenantId: string, days: number): Promise<ApiUsageTotals> {
    return withTenantTx({ tenantId }, async (tx) => {
      const [row] = await tx
        .select({
          calls: sum(apiKeyUsageDaily.calls),
          billedCalls: sum(apiKeyUsageDaily.billedCalls),
          creditsSpent: sum(apiKeyUsageDaily.creditsSpent),
        })
        .from(apiKeyUsageDaily)
        .where(
          and(
            eq(apiKeyUsageDaily.tenantId, tenantId),
            gte(apiKeyUsageDaily.day, sql`(now() AT TIME ZONE 'utc')::date - ${days}::int`),
          ),
        );
      // sum() answers NULL over an empty set — a tenant that has never called the API has zero usage, not
      // unknown usage, and the dashboard should render "0" rather than an empty tile.
      return {
        calls: Number(row?.calls ?? 0),
        billedCalls: Number(row?.billedCalls ?? 0),
        creditsSpent: Number(row?.creditsSpent ?? 0),
      };
    });
  },
};
