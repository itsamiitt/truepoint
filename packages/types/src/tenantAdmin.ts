// tenantAdmin.ts — platform-admin TENANT lifecycle + manual credit-ops contract (13a Area 1, ADR-0011/0032,
// 07 §7). Single source of truth shared by apps/api (validates the request bodies) and apps/admin (derives
// its view types). These are the staff *mutation* shapes that sit alongside the read-only directory/detail in
// staffAdmin.ts / platformAdminReads. Every sensitive action carries a mandatory `reason` recorded in the
// immutable platform_audit_log — the same consent discipline as impersonation (never a blank excuse).

import { z } from "zod";

// ── Tenant lifecycle (suspend / reactivate) ────────────────────────────────────────────────────────────

/** Suspend or reactivate an org. The body is just the mandatory justification (min 5 chars) — the target
 *  tenant is the path param and the new status is implied by the endpoint, never trusted from the body. */
export const tenantStatusChangeSchema = z.object({
  reason: z.string().min(5).max(500),
});
export type TenantStatusChangeInput = z.infer<typeof tenantStatusChangeSchema>;

// ── Manual credit grant / adjustment (07 §7) ───────────────────────────────────────────────────────────

/** A signed credit delta against the tenant counter, with a mandatory reason (07 §7: "corrections are direct
 *  adjustments … each issued with a reason and audit-logged"). Positive = grant (top-up / goodwill), negative
 *  = debit (chargeback / correction). Bounded to ±1,000,000 to blunt a fat-finger; the server's FOR UPDATE +
 *  the DB CHECK(reveal_credit_balance >= 0) are the authoritative overdraft guards. */
export const creditAdjustSchema = z.object({
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((n) => n !== 0, { message: "delta must be a non-zero whole number" }),
  reason: z.string().min(5).max(500),
});
export type CreditAdjustInput = z.infer<typeof creditAdjustSchema>;

/** The result of a credit adjustment — the new authoritative balance, echoed for the console to display. */
export const creditAdjustResultSchema = z.object({
  tenantId: z.string().uuid(),
  delta: z.number().int(),
  balanceAfter: z.number().int(),
});
export type CreditAdjustResult = z.infer<typeof creditAdjustResultSchema>;
