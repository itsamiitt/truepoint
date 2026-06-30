// platformTrustReads.ts — read-only cross-tenant TRUST & ABUSE signals for the platform-admin trust cockpit
// (13 §3, abuse-ops). Runs inside the audited withPlatformTx (owner connection, bypasses RLS) so it sees every
// tenant. SUM/COUNT only — NON-PII (counts, never identity rows). Derives signals from data we already own:
// signup velocity (tenants/users created_at), a free/disposable-email heuristic (users.email is plaintext
// citext), active abuse/fraud holds (account_holds), and the tenant-status mix. Mirrors platformBillingReads /
// platformDataQualityReads (the sibling cross-tenant read repos + their typecheck-safe raw-query shape).

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/** Rolling new-record counts (the velocity signal: a spike is a signup-abuse tell). */
export interface SignupVelocity {
  d1: number;
  d7: number;
  d30: number;
  total: number;
}

/** A labelled count (a hold kind, or a tenant status). */
export interface CountBucket {
  key: string;
  count: number;
}

export interface TrustSignals {
  tenants: SignupVelocity;
  users: SignupVelocity;
  /** Users created in the last 30 days whose email domain is a known free/disposable provider (a HEURISTIC
   *  abuse tell for a B2B product — not proof; staff triage from it). */
  freeEmailSignups30d: number;
}

const VELOCITY = sql`
  count(*) FILTER (WHERE created_at >= now() - interval '1 day')::bigint   AS d1,
  count(*) FILTER (WHERE created_at >= now() - interval '7 days')::bigint  AS d7,
  count(*) FILTER (WHERE created_at >= now() - interval '30 days')::bigint AS d30,
  count(*)::bigint AS total
`;

export const platformTrustReadRepository = {
  /** Signup velocity (tenants + users) + the free/disposable-email signup heuristic. Three bounded aggregates. */
  async signals(tx: Tx): Promise<TrustSignals> {
    const [t] = (await tx.execute(sql`SELECT ${VELOCITY} FROM tenants`)) as unknown as Array<{
      d1: number;
      d7: number;
      d30: number;
      total: number;
    }>;
    const [u] = (await tx.execute(sql`SELECT ${VELOCITY} FROM users`)) as unknown as Array<{
      d1: number;
      d7: number;
      d30: number;
      total: number;
    }>;
    const [f] = (await tx.execute(sql`
      SELECT count(*)::bigint AS n
      FROM users
      WHERE created_at >= now() - interval '30 days'
        AND lower(split_part(email, '@', 2)) IN (
          'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','aol.com',
          'proton.me','protonmail.com','gmx.com','mail.com','mailinator.com',
          'guerrillamail.com','10minutemail.com','tempmail.com','yopmail.com','trashmail.com'
        )
    `)) as unknown as Array<{ n: number }>;
    const v = (r?: { d1: number; d7: number; d30: number; total: number }): SignupVelocity => ({
      d1: Number(r?.d1 ?? 0),
      d7: Number(r?.d7 ?? 0),
      d30: Number(r?.d30 ?? 0),
      total: Number(r?.total ?? 0),
    });
    return { tenants: v(t), users: v(u), freeEmailSignups30d: Number(f?.n ?? 0) };
  },

  /** Active (un-lifted) account holds grouped by kind — the live abuse/fraud/payment flags across the platform. */
  async activeHoldsByKind(tx: Tx): Promise<CountBucket[]> {
    const rows = (await tx.execute(sql`
      SELECT kind AS key, count(*)::bigint AS n
      FROM account_holds
      WHERE lifted_at IS NULL
      GROUP BY kind
      ORDER BY n DESC
    `)) as unknown as Array<{ key: string; n: number }>;
    return rows.map((r) => ({ key: r.key, count: Number(r.n) }));
  },

  /** The tenant-status mix (active / suspended / pending …) — the lifecycle/abuse-action breakdown. */
  async tenantsByStatus(tx: Tx): Promise<CountBucket[]> {
    const rows = (await tx.execute(sql`
      SELECT status AS key, count(*)::bigint AS n
      FROM tenants
      GROUP BY status
      ORDER BY n DESC
    `)) as unknown as Array<{ key: string; n: number }>;
    return rows.map((r) => ({ key: r.key, count: Number(r.n) }));
  },
};
