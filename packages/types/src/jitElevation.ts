// jitElevation.ts — just-in-time elevation contract (13a F1, ADR-0011 / 13 §2). The highest-impact staff
// actions — moving a tenant's credit balance, suspending an org — require the operator to mint a short-lived,
// reason-bearing, tenant-scoped *elevation* first, which the action then consumes in-tx. This is the seam
// doc 13 §2 calls for: time-boxed, reason-required, and (later) optionally peer-approved. v1 is self-service
// (auto-approved); the elevation record carries an approved_by column so peer-approval is a config flip, not
// a re-architecture. No token material lives here — an elevation is a DB-backed grant, not a bearer token.

import { z } from "zod";

/** The closed set of sensitive action CLASSES that require an elevation. A class is coarser than an audit
 *  action: `credit.adjust` covers any credit move (a positive grant audited as `credit.grant` or a debit as
 *  `credit.adjust`); `tenant.suspend` covers org suspension. Reactivation / restorative actions are not
 *  gated. New gated actions (GDPR delete, full impersonation) extend this list. */
export const jitAction = z.enum(["credit.adjust", "tenant.suspend"]);
export type JitAction = z.infer<typeof jitAction>;

/** Request an elevation. `targetTenantId` scopes it to one org — an elevation minted for tenant A can never be
 *  consumed by an action on tenant B. `reason` (min 5) is the justification recorded in platform_audit_log. */
export const requestElevationSchema = z.object({
  action: jitAction,
  reason: z.string().min(5).max(500),
  targetTenantId: z.string().uuid(),
});
export type RequestElevationInput = z.infer<typeof requestElevationSchema>;

/** An elevation as shown to the operator (the active-elevations list + the grant response). No secret/token. */
export const elevationViewSchema = z.object({
  id: z.string().uuid(),
  action: jitAction,
  reason: z.string(),
  targetTenantId: z.string().uuid().nullable(),
  status: z.string(), // active | consumed (expiry is derived from expiresAt)
  grantedAt: z.string(), // ISO-8601
  expiresAt: z.string(), // ISO-8601 hard time-box
});
export type ElevationView = z.infer<typeof elevationViewSchema>;
