// entitlementRepository.ts — reads the resolved per-tenant feature caps and the usage counted against them
// (Phase 1 S-09/S-10; 06-roadmap "Free caps enforced").
//
// READ-ONLY on the app path, and that is structural rather than a convention: rls/entitlement.sql grants a
// SELECT policy and NO write policy under FORCE RLS, so leadwolf_app cannot insert, update or delete a row
// whatever this file does. A role that can grant itself an entitlement has no cap at all. Writes happen on the
// owner / withPlatformTx path — plan sync, Stripe hooks, staff grants, and (Phase 3) Community activation.
//
// Usage is counted from usage_event rather than a rollup counter. The count comes off idx_usage_event_cap; a
// counter is what you add when a slow log asks for one, not in advance — and a denormalized counter that drifts
// from the events is worse than a slightly slower query, because a cap enforced off a wrong number is
// indistinguishable from a bug in the caller.

import { and, count, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { entitlement } from "../schema/entitlement.ts";
import { usageEvent } from "../schema/usageEvent.ts";

export interface EntitlementRow {
  key: string;
  /** null = unlimited. DISTINCT from 0, which means the feature is off for this tenant. */
  cap: number | null;
  period: string | null;
  source: string;
}

export const entitlementRepository = {
  /** Every LIVE entitlement row for a tenant (an expired grant is not an entitlement). */
  async liveForTenant(tx: Tx, tenantId: string): Promise<EntitlementRow[]> {
    const rows = await tx
      .select({
        key: entitlement.key,
        cap: entitlement.cap,
        period: entitlement.period,
        source: entitlement.source,
      })
      .from(entitlement)
      .where(
        and(
          eq(entitlement.tenantId, tenantId),
          or(isNull(entitlement.expiresAt), gt(entitlement.expiresAt, sql`now()`)),
        ),
      );
    return rows;
  },

  /**
   * How much of `entitlementKey` this tenant has used in the CURRENT period.
   *
   * `month` is the calendar month via date_trunc, not a rolling 30 days: a cap a user cannot predict the reset
   * of reads as a bug, and every billing surface in this product already speaks in calendar periods.
   * A null/'lifetime' period counts everything ever.
   */
  async usedInPeriod(
    tx: Tx,
    tenantId: string,
    entitlementKey: string,
    period: string | null,
  ): Promise<number> {
    const since =
      period === "month" ? sql`date_trunc('month', now())` : sql`'-infinity'::timestamptz`;
    const [row] = await tx
      .select({ n: count() })
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.tenantId, tenantId),
          eq(usageEvent.entitlementKey, entitlementKey),
          sql`${usageEvent.occurredAt} >= ${since}`,
        ),
      );
    return Number(row?.n ?? 0);
  },
};
