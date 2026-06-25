// sendQuotaRepository.ts — the per-tenant email send-quota counter (M12, email-planning/13 P0/P1, 15 §A.6,
// known-gap #3). This COPIES the creditRepository discipline (07 §3, ADR-0007), it does not reinvent a lock:
// a SELECT … FOR UPDATE on the tenant row serializes concurrent sends, and the DB CHECK
// (tenants_email_send_quota_nonneg) makes an over-quota increment impossible. email_send_quota IS NULL means
// unlimited. The counter is consumed INSIDE the send tx at P1 (before email.send is enabled), exactly where
// creditRepository.lockBalance/decrement is consumed inside the reveal tx — the send transaction (sendStep)
// stays the single authority, the adapter is the only new code there.

import { sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";

export interface QuotaSnapshot {
  quota: number | null; // null = unlimited
  used: number;
}

/** The send-quota snapshot plus the period anchor — the GET /send-quota read DTO. */
export interface QuotaReadout extends QuotaSnapshot {
  periodStart: Date;
}

/** Thrown when a tenant has consumed its send-quota for the period. Core maps it to a 429-style problem. */
export class SendQuotaExceededError extends Error {
  readonly code = "send_quota_exceeded";
  constructor(
    public readonly quota: number,
    public readonly used: number,
  ) {
    super(`Email send-quota exhausted (${used}/${quota}).`);
    this.name = "SendQuotaExceededError";
  }
}

export const sendQuotaRepository = {
  /**
   * Lock the tenant's send-quota counter for the duration of the send tx: SELECT … FOR UPDATE on the tenant
   * row (the creditRepository.lockBalance idiom). Returns the current quota + usage under the lock.
   */
  async lock(tx: Tx, tenantId: string): Promise<QuotaSnapshot> {
    const rows = (await tx.execute(
      sql`SELECT email_send_quota AS quota, email_send_used AS used
          FROM tenants WHERE id = ${tenantId} FOR UPDATE`,
    )) as unknown as Array<{ quota: number | null; used: number }>;
    if (rows.length === 0) throw new Error("tenant row not visible in scoped transaction");
    const r = rows[0]!;
    return { quota: r.quota === null ? null : Number(r.quota), used: Number(r.used) };
  },

  /**
   * Consume one send under the lock taken by lock(): increment email_send_used. The DB CHECK makes an
   * over-quota increment impossible (the UPDATE throws). Callers should pre-check via assertWithinQuota for a
   * clean domain error; this is the structural backstop. No-op semantics when quota is null (unlimited) —
   * still records usage for billing/analytics.
   */
  async consume(tx: Tx, tenantId: string, count = 1): Promise<void> {
    await tx.execute(
      sql`UPDATE tenants SET email_send_used = email_send_used + ${count} WHERE id = ${tenantId}`,
    );
  },

  /**
   * Set a tenant's send-quota (null = unlimited) — the platform-admin per-tenant limit (M12 P6). Run inside
   * the caller's (platform) tx so the change and its audit row commit together.
   */
  async setQuota(tx: Tx, tenantId: string, quota: number | null): Promise<void> {
    await tx.execute(sql`UPDATE tenants SET email_send_quota = ${quota} WHERE id = ${tenantId}`);
  },

  /**
   * Refund `count` previously-consumed sends — the send-gate releases the unit it pre-consumed when the send
   * itself fails (so a failed send doesn't burn quota). Floored at 0 (GREATEST) so a double-release can never
   * push usage negative. Run inside the tenant tx.
   */
  async release(tx: Tx, tenantId: string, count = 1): Promise<void> {
    await tx.execute(
      sql`UPDATE tenants SET email_send_used = GREATEST(0, email_send_used - ${count})
          WHERE id = ${tenantId}`,
    );
  },

  /** Non-locking read of the tenant's send-quota for the GET /send-quota surface. RLS-scoped. */
  async snapshot(scope: TenantScope): Promise<QuotaReadout> {
    return withTenantTx(scope, async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT email_send_quota AS quota, email_send_used AS used,
                   email_send_period_start AS period_start
            FROM tenants WHERE id = ${scope.tenantId}`,
      )) as unknown as Array<{ quota: number | null; used: number; period_start: Date }>;
      if (rows.length === 0) throw new Error("tenant row not visible in scoped transaction");
      const r = rows[0]!;
      return {
        quota: r.quota === null ? null : Number(r.quota),
        used: Number(r.used),
        periodStart: new Date(r.period_start),
      };
    });
  },

  /**
   * The clean pre-check: throw SendQuotaExceededError BEFORE attempting the send when the tenant is at/over
   * quota. Run under the lock (after lock()), so the decision is serialized with concurrent sends. Unlimited
   * (quota null) never throws.
   */
  assertWithinQuota(snapshot: QuotaSnapshot, count = 1): void {
    if (snapshot.quota === null) return;
    if (snapshot.used + count > snapshot.quota) {
      throw new SendQuotaExceededError(snapshot.quota, snapshot.used);
    }
  },

  /**
   * Reset the usage window (the period roll-over: monthly/daily). Sets email_send_used = 0 and stamps
   * email_send_period_start. Driven by the P6 retention/period sweep; tenant-targeted, idempotent per period.
   */
  async resetPeriod(tx: Tx, tenantId: string): Promise<void> {
    await tx.execute(
      sql`UPDATE tenants SET email_send_used = 0, email_send_period_start = now() WHERE id = ${tenantId}`,
    );
  },
};
