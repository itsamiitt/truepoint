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
import { approvalRequests } from "../schema/platformOps.ts";
import { validationRules } from "../schema/validationRules.ts";
import type { PlatformApprovalRow, PlatformValidationRuleRow } from "./platformAdminReads.ts";

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

/** The outcome of an approve/reject decision, mapped to the right HTTP result INSIDE the tx (rolling the audit
 *  row back on a refusal): unknown id → 404, not pending → 422, the requester deciding their own → 403
 *  (maker != checker), else the decided row. */
export interface ApprovalDecisionOutcome {
  found: boolean;
  notPending: boolean;
  selfApproval: boolean;
  row: PlatformApprovalRow | null;
}

/** Outcome of a DSAR transition, so the caller maps it to the right HTTP result IN-tx (rolling the audit row
 *  back on a refusal): unknown id → 404, an illegal or terminal-state transition → 422 (invalidFrom = the
 *  blocking current state), else applied. */
export interface DsarTransitionOutcome {
  found: boolean;
  invalidFrom: string | null;
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
  ): Promise<DsarTransitionOutcome> {
    // Lock the row + read the current state so the transition is ENFORCED server-side (the console's per-row
    // buttons are UX only — a crafted request must not write a nonsensical trail). Forward-only:
    // received → verifying|processing|rejected, verifying → processing|rejected, processing → rejected;
    // terminal states (completed|rejected) never transition.
    const rows = (await tx.execute(
      sql`SELECT status FROM dsar_requests WHERE id = ${id}::uuid FOR UPDATE`,
    )) as unknown as Array<{ status: string }>;
    if (rows.length === 0) return { found: false, invalidFrom: null };
    const from = rows[0]!.status;
    const legal: Record<string, readonly string[]> = {
      received: ["verifying", "processing", "rejected"],
      verifying: ["processing", "rejected"],
      processing: ["rejected"],
    };
    if (!legal[from]?.includes(status)) return { found: true, invalidFrom: from };
    await tx
      .update(dsarRequests)
      .set({ status, ...(status === "processing" ? { verifiedAt: new Date() } : {}) })
      .where(eq(dsarRequests.id, id));
    return { found: true, invalidFrom: null };
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

  /**
   * File a maker-checker approval REQUEST for a high-risk Data-management op (database-management-research 09).
   * The MAKER (data:manage) supplies the operation, its params, the target org (null = platform-wide), a reason,
   * and a hard expiry. status defaults to 'pending'. Returns the created row for the audit/view.
   */
  async createApproval(
    tx: Tx,
    input: {
      operation: string;
      params: Record<string, unknown>;
      targetTenantId: string | null;
      requestedByUserId: string;
      requestReason: string;
      expiresAt: Date;
    },
  ): Promise<PlatformApprovalRow> {
    const [row] = await tx
      .insert(approvalRequests)
      .values({
        operation: input.operation,
        params: input.params,
        targetTenantId: input.targetTenantId,
        requestedByUserId: input.requestedByUserId,
        requestReason: input.requestReason,
        expiresAt: input.expiresAt,
      })
      .returning();
    return row as PlatformApprovalRow;
  },

  /**
   * Decide (approve|reject) a pending request — the CHECKER path (data:review). The request row is taken
   * FOR UPDATE (the serialization adjustCredits/refundPurchase use) so two checkers can't race a decision.
   * SEPARATION OF DUTIES is enforced HERE, server-side: the requester can NEVER decide their own request
   * (selfApproval → the caller raises 403 INSIDE the tx, rolling the audit row back). An unknown id →
   * found:false (404); a non-pending request → notPending (422). On success the
   * status/decided_by/decision_reason/decided_at are set and the row returned.
   */
  async decideApproval(
    tx: Tx,
    id: string,
    deciderUserId: string,
    decision: "approved" | "rejected",
    reason: string,
  ): Promise<ApprovalDecisionOutcome> {
    const locked = (await tx.execute(
      sql`SELECT status, requested_by_user_id AS requester FROM approval_requests
          WHERE id = ${id}::uuid FOR UPDATE`,
    )) as unknown as Array<{ status: string; requester: string }>;
    if (locked.length === 0)
      return { found: false, notPending: false, selfApproval: false, row: null };
    const current = locked[0]!;
    if (current.status !== "pending")
      return { found: true, notPending: true, selfApproval: false, row: null };
    // Maker != checker: a request can never be decided by the staff member who filed it.
    if (current.requester === deciderUserId)
      return { found: true, notPending: false, selfApproval: true, row: null };
    const [row] = await tx
      .update(approvalRequests)
      .set({
        status: decision,
        decidedByUserId: deciderUserId,
        decisionReason: reason,
        decidedAt: new Date(),
      })
      .where(eq(approvalRequests.id, id))
      .returning();
    return {
      found: true,
      notPending: false,
      selfApproval: false,
      row: (row ?? null) as PlatformApprovalRow | null,
    };
  },

  /**
   * Mark an APPROVED request executed (status → executed, executed_at = now). Called in the SAME tx as the op's
   * execution, immediately after a successful run (database-management-research 09; run-on-approve), so the
   * approval, the op, and the executed marker all commit — or roll back — together.
   */
  async markApprovalExecuted(tx: Tx, id: string): Promise<void> {
    await tx
      .update(approvalRequests)
      .set({ status: "executed", executedAt: new Date() })
      .where(eq(approvalRequests.id, id));
  },

  /** Create a CUSTOM data-quality validation rule (the rule-builder, data:manage). Returns the created row. */
  async createValidationRule(
    tx: Tx,
    input: { name: string; field: string; checkType: string; config: unknown; enabled: boolean },
  ): Promise<PlatformValidationRuleRow> {
    const [row] = await tx
      .insert(validationRules)
      .values({
        name: input.name,
        field: input.field,
        checkType: input.checkType,
        config: input.config as Record<string, unknown>,
        enabled: input.enabled,
      })
      .returning();
    return row as PlatformValidationRuleRow;
  },

  /** Update a custom rule. Returns rows touched (0 = unknown id, so the caller raises a 404). */
  async updateValidationRule(
    tx: Tx,
    id: string,
    input: { name: string; field: string; checkType: string; config: unknown; enabled: boolean },
  ): Promise<number> {
    const updated = await tx
      .update(validationRules)
      .set({
        name: input.name,
        field: input.field,
        checkType: input.checkType,
        config: input.config as Record<string, unknown>,
        enabled: input.enabled,
        updatedAt: new Date(),
      })
      .where(eq(validationRules.id, id))
      .returning({ id: validationRules.id });
    return updated.length;
  },

  /** Enable/disable a custom rule. Returns rows touched (0 = unknown id → 404). */
  async setValidationRuleEnabled(tx: Tx, id: string, enabled: boolean): Promise<number> {
    const updated = await tx
      .update(validationRules)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(validationRules.id, id))
      .returning({ id: validationRules.id });
    return updated.length;
  },

  /** Delete a custom rule (built-ins aren't rows, so can't be deleted). Returns rows touched (0 = unknown → 404). */
  async deleteValidationRule(tx: Tx, id: string): Promise<number> {
    const deleted = await tx
      .delete(validationRules)
      .where(eq(validationRules.id, id))
      .returning({ id: validationRules.id });
    return deleted.length;
  },
};
