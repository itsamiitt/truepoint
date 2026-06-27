// userAdmin.ts — platform-admin global-USER management contract (13a Area 2, ADR-0011/0032, 13 §3.2). The
// staff *mutation* shapes for the cross-tenant Users directory, alongside the read-only listing in
// platformAdminReads. Like the tenant lifecycle ops, every action carries a mandatory `reason` recorded in
// the immutable platform_audit_log. (Reset-MFA / force-password-reset / revoke-sessions land in a later slice
// — they reuse the packages/auth primitives over the platform path.)

import { z } from "zod";

/** Deactivate or reactivate a global user. The body is just the mandatory justification (min 5 chars) — the
 *  target user is the path param and the new status is implied by the endpoint, never trusted from the body. */
export const userStatusChangeSchema = z.object({
  reason: z.string().min(5).max(500),
});
export type UserStatusChangeInput = z.infer<typeof userStatusChangeSchema>;
