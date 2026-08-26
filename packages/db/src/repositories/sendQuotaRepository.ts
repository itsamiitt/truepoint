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

/**
 * Length of the usage window, in days.
 *
 * `resetPeriod` was written for "the P6 retention/period sweep" and that sweep was never built, so NOTHING
 * reset `email_send_used` — not a job, not a trigger, not a DEFAULT. Usage only ever went up. A tenant with a
 * quota therefore burned it once and was blocked from sending FOREVER, with no operator action able to clear
 * it short of hand-written SQL. It stayed invisible because `email_send_quota` has no default: every tenant is
 * unlimited (NULL) until a platform admin calls setQuota, and the trap springs the moment one does.
 *
 * 30 days, not a calendar month, and this is an ASSUMPTION rather than a settled rule — the method's own
 * comment says "monthly/daily" and never picked. Recorded in docs/strategy/decisions.md for a human: quota
 * windows usually want to track the billing cycle, and if these quotas are meant to be billing-aligned this
 * constant should be replaced by the cycle boundary rather than tuned. A rolling 30 days is the choice that
 * is defensible without knowing the answer: it never grants a tenant two windows' worth of sends in one
 * calendar month, which is the failure direction that costs money.
 */
export const SEND_QUOTA_PERIOD_DAYS = 30;

const PERIOD_MS = SEND_QUOTA_PERIOD_DAYS * 24 * 60 * 60 * 1000;

/**
 * Has the usage window elapsed? Pure, exported, and unit-tested — the roll-over decision is the whole fix,
 * so it is testable without a database.
 *
 * Boundary is inclusive (`>=`): a window that started exactly PERIOD_MS ago is over. A future periodStart
 * (clock skew, or a row stamped ahead) reads as not-elapsed rather than throwing — the conservative
 * direction, since the alternative is resetting a live counter on a bad timestamp.
 */
export function isPeriodElapsed(periodStart: Date, now: Date): boolean {
  return now.getTime() - periodStart.getTime() >= PERIOD_MS;
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
      sql`SELECT email_send_quota AS quota, email_send_used AS used,
                 email_send_period_start AS period_start
          FROM tenants WHERE id = ${tenantId} FOR UPDATE`,
    )) as unknown as Array<{ quota: number | null; used: number; period_start: Date }>;
    if (rows.length === 0) throw new Error("tenant row not visible in scoped transaction");
    const r = rows[0]!;

    // Roll the window here, under the lock we already hold, rather than from a sweep. A sweep is another
    // thing that can be down, mis-scheduled, or never built — which is exactly how this counter came to have
    // no reset at all. Rolling at the point of use is self-healing: the first send after the window elapses
    // pays a single UPDATE, and a tenant whose workers were offline for a month is still correct on the next
    // send. FOR UPDATE above already serializes this against concurrent sends, so no two of them can both
    // observe the elapsed window and double-reset.
    if (isPeriodElapsed(new Date(r.period_start), new Date())) {
      await sendQuotaRepository.resetPeriod(tx, tenantId);
      return { quota: r.quota === null ? null : Number(r.quota), used: 0 };
    }

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
      // Report the EFFECTIVE usage. This read must agree with what the next send will do, and that send rolls
      // an elapsed window to zero — so showing the stale pre-roll number here would tell a user they are out
      // of quota while the very next send succeeds. Read-only on purpose: a GET does not write, so the actual
      // reset still happens under the send's lock.
      const periodStart = new Date(r.period_start);
      const elapsed = isPeriodElapsed(periodStart, new Date());
      return {
        quota: r.quota === null ? null : Number(r.quota),
        used: elapsed ? 0 : Number(r.used),
        periodStart,
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
   * Reset the usage window: sets email_send_used = 0 and stamps email_send_period_start.
   *
   * Called by lock() when the window has elapsed, and available to a platform admin who needs to clear a
   * counter by hand. It previously documented itself as "driven by the P6 retention/period sweep" — a sweep
   * that was never built, which left this the only reset in the system and gave it no caller at all. Run it
   * inside a transaction that holds the tenant row, or a concurrent send can consume against the pre-reset
   * count.
   */
  async resetPeriod(tx: Tx, tenantId: string): Promise<void> {
    await tx.execute(
      sql`UPDATE tenants SET email_send_used = 0, email_send_period_start = now() WHERE id = ${tenantId}`,
    );
  },
};
