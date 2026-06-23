// staffAdmin.ts — the platform STAFF RBAC + impersonation-with-consent contract (ADR-0011, 13 §11). Single
// source of truth shared by apps/api (validates the request bodies) and apps/admin (derives its view types).
// Staff roles reuse the canonical `staffRole` enum from auth.ts — there is exactly one staff-role vocabulary.
// No secret or token material lives here: an impersonation session record carries only banner/justification
// metadata; the scoped "login-as" token is minted server-side and is WIRE-deferred.

import { z } from "zod";
import { staffRole } from "./auth.ts";

// ── Staff RBAC ─────────────────────────────────────────────────────────────────────────────────────────

/** A platform-staff member as shown in the console directory (joined platform_staff → users). */
export const staffMemberViewSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  fullName: z.string().nullable(),
  staffRole,
  status: z.string(), // active|revoked
  grantedAt: z.string(), // ISO-8601
});
export type StaffMemberView = z.infer<typeof staffMemberViewSchema>;

/** Grant (or re-grant) a staff role to a user. The userId is a server-resolved identity, never trusted text. */
export const grantStaffSchema = z.object({
  userId: z.string().uuid(),
  staffRole,
});
export type GrantStaffInput = z.infer<typeof grantStaffSchema>;

// ── Impersonation-with-consent ───────────────────────────────────────────────────────────────────────────

/** Start an impersonation session. A tenant is always required; workspace/user narrow the scope. `reason`
 *  is the mandatory consent/justification recorded in the audit trail (min 5 chars — never an empty excuse). */
export const impersonationStartSchema = z.object({
  targetTenantId: z.string().uuid(),
  targetWorkspaceId: z.string().uuid().optional(),
  targetUserId: z.string().uuid().optional(),
  reason: z.string().min(5).max(500),
});
export type ImpersonationStartInput = z.infer<typeof impersonationStartSchema>;

/** An impersonation session as shown in the console (active banner + history). No token material. */
export const impersonationSessionViewSchema = z.object({
  id: z.string().uuid(),
  staffUserId: z.string().uuid(),
  targetTenantId: z.string().uuid(),
  targetUserId: z.string().uuid().nullable(),
  reason: z.string(),
  startedAt: z.string(), // ISO-8601
  expiresAt: z.string(), // ISO-8601
  endedAt: z.string().nullable(), // ISO-8601 or null while active
});
export type ImpersonationSessionView = z.infer<typeof impersonationSessionViewSchema>;
