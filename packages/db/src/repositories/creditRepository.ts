// creditRepository.ts — data access for the tenant credit counter + Stripe purchases (billing domain,
// 07 §2/§4, ADR-0007). The counter mutations are tx-aware (composed inside the reveal tx / webhook tx);
// the FOR UPDATE lock + the DB CHECK (reveal_credit_balance >= 0) are the double-spend/overdraft guards.

import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { type TenantScope, type Tx, db, withTenantTx } from "../client.ts";
import { contactReveals, creditLedger, purchases } from "../schema/billing.ts";

/** One credit-ledger entry for the CUSTOMER's own statement (M11) — the movement + running balance, no
 *  internal refs. */
export interface CustomerLedgerRow {
  id: string;
  entryType: string;
  delta: number;
  balanceAfter: number | null;
  reason: string | null;
  createdAt: Date;
}

// Opaque keyset cursor over the time-ordered v7 id (id DESC = newest-first; id < cursor = next older page).
function encodeLedgerCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}
function decodeLedgerCursor(cursor: string): string | null {
  try {
    return Buffer.from(cursor, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

/** One day of credit burn for the Home sparkline (07 §2). */
export interface BurnByDayRow {
  day: string; // YYYY-MM-DD
  credits: number;
}

export interface GrantInput {
  tenantId: string;
  stripeEventId: string;
  stripePaymentIntentId?: string | null;
  credits: number;
  amountCents?: number | null;
}

export interface GrantResult {
  granted: boolean; // false when the event was already processed (duplicate webhook)
  balanceAfter: number;
}

/** The credit-ledger entry_type vocabulary (M11 + M12-reserved). Mirrors credit_ledger.entry_type CHECK. */
export type LedgerEntryType =
  | "grant"
  | "spend"
  | "credit_back"
  | "adjustment"
  | "lease"
  | "settle"
  | "release";

/** One append to the credit ledger (ADR-0029). `delta` is SIGNED per the entry_type (the DB CHECK enforces it). */
export interface LedgerEntryInput {
  tenantId: string;
  workspaceId?: string | null;
  entryType: LedgerEntryType;
  delta: number;
  balanceAfter?: number | null;
  idempotencyKey: string;
  revealId?: string | null;
  purchaseId?: string | null;
  actorUserId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export const creditRepository = {
  /** Serialize concurrent reveals for one tenant: SELECT … FOR UPDATE on the counter row (07 §3). Returns the
   *  total balance AND the perishable subscription portion (M11 buckets, ADR-0041) so the caller can split the
   *  spend subscription-first. */
  async lockBalance(
    tx: Tx,
    tenantId: string,
  ): Promise<{ balance: number; subscriptionBalance: number }> {
    const rows = (await tx.execute(
      sql`SELECT reveal_credit_balance AS balance, subscription_credit_balance AS sub
          FROM tenants WHERE id = ${tenantId} FOR UPDATE`,
    )) as unknown as Array<{ balance: number; sub: number }>;
    if (rows.length === 0) throw new Error("tenant row not visible in scoped transaction");
    return { balance: Number(rows[0]!.balance), subscriptionBalance: Number(rows[0]!.sub) };
  },

  /** Decrement under the lock taken by lockBalance — subscription-first (M11/ADR-0041): `fromSubscription`
   *  (= min(cost, subscription balance)) comes off the perishable bucket, the rest off purchased credits. Both
   *  CHECKs hold — total ≥ 0 (existing), and 0 ≤ sub ≤ total because cost ≥ fromSubscription ≥ 0. */
  async decrement(tx: Tx, tenantId: string, cost: number, fromSubscription: number): Promise<void> {
    await tx.execute(
      sql`UPDATE tenants
          SET reveal_credit_balance = reveal_credit_balance - ${cost},
              subscription_credit_balance = subscription_credit_balance - ${fromSubscription}
          WHERE id = ${tenantId}`,
    );
  },

  /** Read the balance without locking (free re-reveal path + GET /credits/balance). */
  async currentBalance(tx: Tx, tenantId: string): Promise<number> {
    const rows = (await tx.execute(
      sql`SELECT reveal_credit_balance AS balance FROM tenants WHERE id = ${tenantId}`,
    )) as unknown as Array<{ balance: number }>;
    return rows.length > 0 ? Number(rows[0]!.balance) : 0;
  },

  /**
   * Read the tenant's balance. RLS-scoped read. Pass `tx` to compose this into a caller's existing scoped
   * transaction (e.g. the Home summary fan-out, which shares ONE withTenantTx); omit it for a standalone read.
   */
  async getBalance(scope: TenantScope, tx?: Tx): Promise<number> {
    if (tx) return creditRepository.currentBalance(tx, scope.tenantId);
    return withTenantTx(scope, (t) => creditRepository.currentBalance(t, scope.tenantId));
  },

  /**
   * Per-day credit burn over the last `days` days for the Home sparkline (07 §2): SUM(credits_consumed)
   * grouped by the reveal day, ascending. Workspace-scoped via RLS — only this workspace's reveals.
   * Pass `tx` to run on a caller's existing scoped transaction; omit it for a standalone read.
   */
  async burnByDay(scope: TenantScope, days = 30, tx?: Tx): Promise<BurnByDayRow[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const run = async (t: Tx): Promise<BurnByDayRow[]> => {
      const rows = await t
        .select({
          day: sql<string>`to_char(date_trunc('day', ${contactReveals.revealedAt}), 'YYYY-MM-DD')`,
          credits: sql<number>`coalesce(sum(${contactReveals.creditsConsumed}), 0)::int`,
        })
        .from(contactReveals)
        .where(gte(contactReveals.revealedAt, since))
        .groupBy(sql`date_trunc('day', ${contactReveals.revealedAt})`)
        .orderBy(sql`date_trunc('day', ${contactReveals.revealedAt}) asc`);
      return rows.map((r) => ({ day: r.day, credits: Number(r.credits) }));
    };
    return tx ? run(tx) : withTenantTx(scope, run);
  },

  /**
   * Idempotent Stripe grant (07 §4): credits land ONLY when the purchases insert wins; a duplicate
   * `stripe_event_id` is a no-op. SYSTEM path — runs on the base connection (no tenant GUC: the webhook
   * carries no session), trusted because the event signature was verified at the route. M11 (ADR-0029): on a
   * real grant, post the paired `grant` ledger entry in the SAME tx as the counter update (atomic; idempotent
   * on (tenant, grant:<stripe_event_id>)). The insert runs on the owner connection → bypasses ENABLE RLS.
   */
  async grantFromEvent(input: GrantInput): Promise<GrantResult> {
    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(purchases)
        .values({
          tenantId: input.tenantId,
          stripeEventId: input.stripeEventId,
          stripePaymentIntentId: input.stripePaymentIntentId ?? null,
          credits: input.credits,
          amountCents: input.amountCents ?? null,
        })
        .onConflictDoNothing({ target: purchases.stripeEventId })
        .returning({ id: purchases.id });
      const granted = inserted.length > 0;
      if (granted) {
        await tx.execute(
          sql`UPDATE tenants SET reveal_credit_balance = reveal_credit_balance + ${input.credits}
              WHERE id = ${input.tenantId}`,
        );
      }
      const rows = (await tx.execute(
        sql`SELECT reveal_credit_balance AS balance FROM tenants WHERE id = ${input.tenantId}`,
      )) as unknown as Array<{ balance: number }>;
      const balanceAfter = rows.length > 0 ? Number(rows[0]!.balance) : 0;
      if (granted) {
        await creditRepository.insertLedger(tx, {
          tenantId: input.tenantId,
          entryType: "grant",
          delta: input.credits,
          balanceAfter,
          idempotencyKey: `grant:${input.stripeEventId}`,
          purchaseId: inserted[0]!.id,
          reason: "stripe_purchase",
          metadata: input.amountCents != null ? { amountCents: input.amountCents } : {},
        });
      }
      return { granted, balanceAfter };
    });
  },

  /**
   * Append one immutable credit-ledger entry (M11, ADR-0029). Composed into the caller's tx so the entry and
   * the counter mutation commit atomically. Idempotent on (tenant_id, idempotency_key): a replayed grant /
   * reveal / adjustment re-posts nothing (ON CONFLICT DO NOTHING) — the ledger never double-counts. The
   * entry_type ↔ delta sign is enforced by the DB CHECK; callers pass the correct sign per ADR-0029.
   */
  async insertLedger(tx: Tx, entry: LedgerEntryInput): Promise<void> {
    await tx
      .insert(creditLedger)
      .values({
        tenantId: entry.tenantId,
        workspaceId: entry.workspaceId ?? null,
        entryType: entry.entryType,
        delta: entry.delta,
        balanceAfter: entry.balanceAfter ?? null,
        idempotencyKey: entry.idempotencyKey,
        revealId: entry.revealId ?? null,
        purchaseId: entry.purchaseId ?? null,
        actorUserId: entry.actorUserId ?? null,
        reason: entry.reason ?? null,
        metadata: entry.metadata ?? {},
      })
      .onConflictDoNothing({ target: [creditLedger.tenantId, creditLedger.idempotencyKey] });
  },

  /**
   * Active tenants that have NOT yet been ledger-backfilled — i.e. carry no `opening_balance:<id>` marker
   * entry. The self-terminating work-list for the one-time backfill sweep (M11). Owner read; bounded.
   */
  async tenantsNeedingLedgerBackfill(tx: Tx, limit: number): Promise<string[]> {
    const rows = (await tx.execute(sql`
      SELECT t.id::text AS tenant_id
      FROM tenants t
      WHERE t.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM credit_ledger cl
          WHERE cl.tenant_id = t.id AND cl.idempotency_key = 'opening_balance:' || t.id::text
        )
      ORDER BY t.id
      LIMIT ${limit}
    `)) as unknown as Array<{ tenant_id: string }>;
    return rows.map((r) => r.tenant_id);
  },

  /**
   * One-time historical ledger backfill for ONE tenant (M11, ADR-0029) — idempotent, composed into a
   * per-tenant tx. (1) Reconstruct `grant` entries from purchases (key grant:<stripe_event_id>, historical
   * created_at) + `spend` entries from charged reveals (key reveal:<reveal_id>), both ON CONFLICT DO NOTHING
   * so any LIVE post-ledger entries are left untouched — the backfill only fills the PRE-ledger gap. (2) Lock
   * the counter, compute residual = counter − SUM(delta), and post ONE `opening_balance` adjustment (key
   * opening_balance:<tenant_id>) that absorbs everything not reconstructed (old admin adjusts, signup bonuses,
   * refund reversals, credit-backs). After it, SUM(delta) == counter exactly. The opening_balance row is posted
   * even at residual 0 so it doubles as the "backfilled" marker (→ the sweep is self-terminating). Returns the
   * residual it absorbed.
   */
  async backfillTenantLedger(tx: Tx, tenantId: string): Promise<{ residual: number }> {
    await tx.execute(sql`
      INSERT INTO credit_ledger (tenant_id, entry_type, delta, idempotency_key, purchase_id, reason, created_at)
      SELECT p.tenant_id, 'grant', p.credits, 'grant:' || p.stripe_event_id, p.id, 'stripe_purchase', p.created_at
      FROM purchases p
      WHERE p.tenant_id = ${tenantId}::uuid
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO credit_ledger (tenant_id, workspace_id, entry_type, delta, idempotency_key, reveal_id, reason, created_at)
      SELECT cr.tenant_id, cr.workspace_id, 'spend', -cr.credits_consumed, 'reveal:' || cr.id::text, cr.id, 'reveal', cr.revealed_at
      FROM contact_reveals cr
      WHERE cr.tenant_id = ${tenantId}::uuid AND cr.credits_consumed > 0
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    `);
    const brows = (await tx.execute(
      sql`SELECT reveal_credit_balance AS c FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`,
    )) as unknown as Array<{ c: number }>;
    const counter = brows.length > 0 ? Number(brows[0]!.c) : 0;
    const srows = (await tx.execute(
      sql`SELECT COALESCE(SUM(delta), 0)::bigint AS s FROM credit_ledger WHERE tenant_id = ${tenantId}::uuid`,
    )) as unknown as Array<{ s: number }>;
    const residual = counter - Number(srows[0]?.s ?? 0);
    await tx.execute(sql`
      INSERT INTO credit_ledger (tenant_id, entry_type, delta, idempotency_key, reason)
      VALUES (${tenantId}::uuid, 'adjustment', ${residual}, ${`opening_balance:${tenantId}`}, 'opening_balance')
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    `);
    return { residual };
  },

  /**
   * The CUSTOMER's own credit ledger (M11) — a keyset page of every balance movement (grants, spends,
   * adjustments, subscription resets, the opening-balance backfill), newest-first over the v7 id. Tenant-scoped:
   * runs under withTenantTx so the ENABLE-RLS policy (tenant_id = app.current_tenant_id) isolates it to the
   * caller's tenant (the explicit tenant_id predicate is belt-and-suspenders + an index prefix). limit+1 probe
   * → nextCursor; null cursor = last page. NOTE: complete only once the ledger backfill has run for a pre-ledger
   * tenant — the api surfaces `backfilled` so the UI can note it.
   */
  async ledgerPage(
    scope: TenantScope,
    opts: { limit?: number; cursor?: string },
  ): Promise<{ rows: CustomerLedgerRow[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const cursorId = opts.cursor ? decodeLedgerCursor(opts.cursor) : null;
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          id: creditLedger.id,
          entryType: creditLedger.entryType,
          delta: creditLedger.delta,
          balanceAfter: creditLedger.balanceAfter,
          reason: creditLedger.reason,
          createdAt: creditLedger.createdAt,
        })
        .from(creditLedger)
        .where(
          cursorId
            ? and(eq(creditLedger.tenantId, scope.tenantId), lt(creditLedger.id, cursorId))
            : eq(creditLedger.tenantId, scope.tenantId),
        )
        .orderBy(desc(creditLedger.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? encodeLedgerCursor(page[page.length - 1]!.id) : null;
      return { rows: page, nextCursor };
    });
  },
};
