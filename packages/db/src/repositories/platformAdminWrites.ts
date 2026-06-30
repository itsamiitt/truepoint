// platformAdminWrites.ts — audited cross-tenant WRITES for the platform super-admin surface (13a Area 1,
// ADR-0011/0032). The sibling of platformAdminReads (which stays strictly read-only). Every method here takes
// the transaction handed to it by withPlatformTx — the owner-role, audited path — so the mutation and its
// immutable platform_audit_log row share ONE transaction: no unaudited privileged write can reach these
// tables, and a write that throws rolls the audit row back with it. The api layer owns the role gate
// (requireStaffRole) and the audit action string; this file owns only the SQL.

import { eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { tenants, users } from "../schema/auth.ts";
import { dsarRequests } from "../schema/compliance.ts";

/** A tenant's lifecycle status the staff console can set (13 §3.1). */
export type TenantLifecycleStatus = "active" | "suspended";

/** A user's account status the staff console can set (13 §3.2). 'suspended' = deactivated. */
export type UserAccountStatus = "active" | "suspended";

/** The outcome of a user status change, so the caller can map it to the right HTTP result INSIDE the tx
 *  (rolling the audit row back on a refusal): unknown user → 404, a protected platform-staff target → 422,
 *  else applied. */
export interface UserStatusOutcome {
  found: boolean;
  blockedPlatformAdmin: boolean;
}

/** The outcome of a purchase refund (13a Area 4): unknown id → 404, already refunded → 422, else the credits
 *  reversed (clamped to the available balance — the bare counter can't go negative) and the new balance. */
export interface RefundOutcome {
  found: boolean;
  alreadyRefunded: boolean;
  reversed: number;
  balanceAfter: number;
}

/** The outcome of a credit adjustment, so the caller can map it to the right HTTP result INSIDE the tx
 *  (and thus roll the audit row back on a no-op): unknown tenant → 404, would-overdraw → 422, else the new
 *  authoritative balance. */
export interface CreditAdjustOutcome {
  found: boolean;
  wouldOverdraw: boolean;
  balanceAfter: number;
}

export const platformAdminWriteRepository = {
  /**
   * Set a tenant's lifecycle status (active|suspended) — the suspend/reactivate mutation (13 §3.1). Returns
   * the number of rows touched (0 = unknown id, so the caller raises a clean 404 inside the tx). `updated_at`
   * is bumped explicitly (no app-wide updated_at trigger on tenants).
   */
  async setTenantStatus(tx: Tx, tenantId: string, status: TenantLifecycleStatus): Promise<number> {
    const updated = await tx
      .update(tenants)
      .set({ status, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId))
      .returning({ id: tenants.id });
    return updated.length;
  },

  /**
   * Apply a signed credit delta to the tenant counter (07 §7 manual grant/adjustment). The tenant row is
   * locked with SELECT … FOR UPDATE — the same serialization the reveal path uses (07 §3) — so a concurrent
   * reveal/grant cannot race the balance. A debit that would drive the balance below zero is reported as
   * `wouldOverdraw` (the caller raises 422) rather than letting the DB CHECK (reveal_credit_balance >= 0)
   * throw a raw constraint error; the CHECK remains the last-line guarantee. An unknown tenant → `found:false`.
   */
  async adjustCredits(tx: Tx, tenantId: string, delta: number): Promise<CreditAdjustOutcome> {
    const rows = (await tx.execute(
      sql`SELECT reveal_credit_balance AS balance FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`,
    )) as unknown as Array<{ balance: number }>;
    if (rows.length === 0) return { found: false, wouldOverdraw: false, balanceAfter: 0 };

    const current = Number(rows[0]!.balance);
    const next = current + delta;
    if (next < 0) return { found: true, wouldOverdraw: true, balanceAfter: current };

    await tx.execute(
      sql`UPDATE tenants SET reveal_credit_balance = ${next}, updated_at = now() WHERE id = ${tenantId}::uuid`,
    );
    return { found: true, wouldOverdraw: false, balanceAfter: next };
  },

  /**
   * Advance a DSAR's workflow state (08 §4) — the staff-drivable transitions ONLY: verifying / processing /
   * rejected. 'completed' is intentionally NOT settable here: fulfilment (the erasure/export process) records
   * completion, never a manual flag — a hand-set 'completed' with no actual fulfilment would be a compliance
   * violation. Entering 'processing' stamps verified_at (identity confirmed). Returns rows touched (0 = unknown
   * id → the caller raises a clean 404 in-tx, rolling the audit row back).
   */
  async setDsarStatus(
    tx: Tx,
    id: string,
    status: "verifying" | "processing" | "rejected",
  ): Promise<number> {
    const updated = await tx
      .update(dsarRequests)
      .set({
        status,
        ...(status === "processing" ? { verifiedAt: new Date() } : {}),
      })
      .where(eq(dsarRequests.id, id))
      .returning({ id: dsarRequests.id });
    return updated.length;
  },

  /**
   * Set a global user's account status (active|suspended) — the deactivate/reactivate mutation (13 §3.2).
   * When `blockPlatformAdmin` is set (the deactivate path), a target that is a platform-staff account is
   * refused (`blockedPlatformAdmin`) rather than updated — so staff can't lock another operator (or, with the
   * caller's own self-check, themselves) out of the console; the staff role must be revoked first. An unknown
   * id → `found:false`. `updated_at` is bumped explicitly (no app-wide updated_at trigger on users).
   */
  async setUserStatus(
    tx: Tx,
    userId: string,
    status: UserAccountStatus,
    opts: { blockPlatformAdmin: boolean },
  ): Promise<UserStatusOutcome> {
    const [row] = await tx
      .select({ isPlatformAdmin: users.isPlatformAdmin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return { found: false, blockedPlatformAdmin: false };
    if (opts.blockPlatformAdmin && row.isPlatformAdmin)
      return { found: true, blockedPlatformAdmin: true };

    await tx.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId));
    return { found: true, blockedPlatformAdmin: false };
  },

  /**
   * Refund a credit-pack purchase (13a Area 4, 07 §6/§7): mark it `refunded` and reverse its credits from the
   * tenant counter. Both the purchase and the tenant row are taken FOR UPDATE. The reversal is CLAMPED to the
   * available balance — a bare counter cannot go negative (the CHECK), so a refund of already-spent credits
   * reverses only what's left; the unrecoverable remainder is the M11 ledger's reconciliation job (07 §2). An
   * unknown purchase → `found:false`; an already-refunded one → `alreadyRefunded:true` (no double reversal).
   */
  async refundPurchase(tx: Tx, tenantId: string, purchaseId: string): Promise<RefundOutcome> {
    const prows = (await tx.execute(
      sql`SELECT credits, status FROM purchases
          WHERE id = ${purchaseId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`,
    )) as unknown as Array<{ credits: number; status: string }>;
    if (prows.length === 0)
      return { found: false, alreadyRefunded: false, reversed: 0, balanceAfter: 0 };
    if (prows[0]!.status === "refunded")
      return { found: true, alreadyRefunded: true, reversed: 0, balanceAfter: 0 };

    const credits = Number(prows[0]!.credits);
    const brows = (await tx.execute(
      sql`SELECT reveal_credit_balance AS balance FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`,
    )) as unknown as Array<{ balance: number }>;
    const balance = Number(brows[0]?.balance ?? 0);
    const reversed = Math.min(credits, balance);
    const balanceAfter = balance - reversed;

    await tx.execute(
      sql`UPDATE tenants SET reveal_credit_balance = ${balanceAfter}, updated_at = now() WHERE id = ${tenantId}::uuid`,
    );
    await tx.execute(sql`UPDATE purchases SET status = 'refunded' WHERE id = ${purchaseId}::uuid`);
    return { found: true, alreadyRefunded: false, reversed, balanceAfter };
  },

  /**
   * Apply a plan template's entitlements to a tenant (13a Area 1 plan-override, 07 §5): set the plan id, seat
   * & workspace caps, and feature flags. Does NOT grant credits (a plan's monthly grant is applied by the
   * recurring billing job, not by this override). Returns rows touched (0 = unknown tenant → caller raises 404).
   */
  async applyPlan(
    tx: Tx,
    tenantId: string,
    plan: {
      plan: string;
      seatLimit: number;
      workspaceLimit: number | null;
      features: Record<string, boolean>;
    },
  ): Promise<number> {
    const updated = await tx
      .update(tenants)
      .set({
        plan: plan.plan,
        seatLimit: plan.seatLimit,
        workspaceLimit: plan.workspaceLimit,
        features: plan.features,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId))
      .returning({ id: tenants.id });
    return updated.length;
  },
};
