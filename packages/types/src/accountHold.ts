// accountHold.ts — staff account-hold / abuse-flag contract (13a Area 7, 13 §3.7). A hold is an abuse / fraud
// / payment freeze a staff operator places on a tenant (with a kind + a reason), tracked and lifted from the
// tenant detail. Distinct from suspend (the lifecycle status, Area 1): a hold is the abuse-review flag. Shared
// by apps/api (validates) and apps/admin (derives its view type). Staff-only data (deny-all to the customer).

import { z } from "zod";

/** Why a tenant is held — a closed vocabulary so holds are reportable. */
export const accountHoldKind = z.enum(["fraud", "payment", "abuse", "compliance", "manual"]);
export type AccountHoldKind = z.infer<typeof accountHoldKind>;

/** Place a hold on a tenant. `reason` (min 5) is the justification recorded in the audit trail. */
export const placeAccountHoldSchema = z.object({
  kind: accountHoldKind,
  reason: z.string().trim().min(5).max(500),
});
export type PlaceAccountHoldInput = z.infer<typeof placeAccountHoldSchema>;

/** A hold as shown in the console (active = liftedAt null). */
export const accountHoldViewSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  kind: accountHoldKind,
  reason: z.string(),
  placedByUserId: z.string().uuid(),
  placedAt: z.string(), // ISO-8601
  liftedAt: z.string().nullable(),
  liftedByUserId: z.string().uuid().nullable(),
});
export type AccountHoldView = z.infer<typeof accountHoldViewSchema>;
