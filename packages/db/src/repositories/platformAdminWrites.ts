// platformAdminWrites.ts — audited cross-tenant WRITES for the platform super-admin surface (13a Area 1,
// ADR-0011/0032). The sibling of platformAdminReads (which stays strictly read-only). Every method here takes
// the transaction handed to it by withPlatformTx — the owner-role, audited path — so the mutation and its
// immutable platform_audit_log row share ONE transaction: no unaudited privileged write can reach these
// tables, and a write that throws rolls the audit row back with it. The api layer owns the role gate
// (requireStaffRole) and the audit action string; this file owns only the SQL.

import { eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { tenants } from "../schema/auth.ts";

/** A tenant's lifecycle status the staff console can set (13 §3.1). */
export type TenantLifecycleStatus = "active" | "suspended";

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
};
