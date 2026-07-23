// auth.ts — the Zod schemas + inferred types that define the authentication contracts (17, ADR-0016/17/18).
// Single source of truth shared by apps/auth, apps/api, apps/web. Validation lives here; logic does not.

import { z } from "zod";

// ── Enums (shared vocabulary; mirror 03 §4 CHECK constraints) ────────────────────────────────────────
export const authMethod = z.enum(["password", "oauth", "magic_link", "sso", "passkey"]);
export type AuthMethod = z.infer<typeof authMethod>;

export const mfaMethodType = z.enum(["totp", "sms", "email", "webauthn"]);
export type MfaMethodType = z.infer<typeof mfaMethodType>;

export const mfaEnforcement = z.enum(["off", "optional", "required"]);
export type MfaEnforcement = z.infer<typeof mfaEnforcement>;

export const workspaceRole = z.enum(["owner", "admin", "member", "viewer"]);
export type WorkspaceRole = z.infer<typeof workspaceRole>;

// Tenant/org-level roles (ADR-0030): granular org administration, one tier ABOVE the workspace. Separate
// from workspaceRole and from the platform staff tier — never mixed. `owner` implies every org capability;
// the others scope a single domain (billing / auth+SSO+SCIM / compliance+DSAR). Resolved server-side from
// tenant_members.org_role and enforced by requireOrgRole.
export const orgRole = z.enum([
  "owner",
  "billing_admin",
  "security_admin",
  "compliance_admin",
  "member",
]);
export type OrgRole = z.infer<typeof orgRole>;

// Platform STAFF roles (ADR-0011): operate the whole platform ACROSS tenants. NEVER mixed with the customer
// org/workspace roles — held in the platform_staff table (deny-all to the app role) and gated by
// requireStaffRole after the `pa` claim. `super_admin` implies every staff capability.
export const staffRole = z.enum([
  "super_admin",
  "support",
  "billing_ops",
  "compliance_officer",
  "read_only",
  "data_ops", // the Database Management team — the data:* write tier (database-management-research 11)
]);
export type StaffRole = z.infer<typeof staffRole>;

// ── Step 1: identifier-first (ADR-0017) ──────────────────────────────────────────────────────────────
export const identifierSchema = z.object({
  email: z.string().email().max(320),
});
export type IdentifierInput = z.infer<typeof identifierSchema>;

/** Where the identifier step routes. REVEALS existence to branch login vs registration (ADR-0020). */
export const identifierRoute = z.enum(["password", "sso", "passkey", "magic", "register"]);
export type IdentifierRoute = z.infer<typeof identifierRoute>;

export const identifierResultSchema = z.object({
  route: identifierRoute,
  email: z.string().email().optional(), // canonical email (a username resolves to its email), when known
  tenantId: z.string().uuid().optional(),
  tenantName: z.string().optional(),
  ssoProvider: z.enum(["saml", "oidc"]).optional(),
});
export type IdentifierResult = z.infer<typeof identifierResultSchema>;

// ── Step 2: credentials ──────────────────────────────────────────────────────────────────────────────
export const passwordLoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});
export type PasswordLoginInput = z.infer<typeof passwordLoginSchema>;

export const magicLinkRequestSchema = z.object({ email: z.string().email().max(320) });
export type MagicLinkRequestInput = z.infer<typeof magicLinkRequestSchema>;

// ── Step 3: MFA challenge ────────────────────────────────────────────────────────────────────────────
export const mfaVerifySchema = z.object({
  method: mfaMethodType,
  code: z.string().min(6).max(12),
  trustDevice: z.boolean().default(false),
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

// ── Step 4: org + workspace selection (ADR-0019) ──────────────────────────────────────────────────────
export const orgSelectionSchema = z.object({ tenantId: z.string().uuid() });
export type OrgSelectionInput = z.infer<typeof orgSelectionSchema>;

export const workspaceSelectionSchema = z.object({ workspaceId: z.string().uuid() });
export type WorkspaceSelectionInput = z.infer<typeof workspaceSelectionSchema>;

// ── Identifier alias + registration (ADR-0019/0020) ──────────────────────────────────────────────────
export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_.-]+$/);

export const loginIdentifierSchema = z.object({
  identifier: z.string().min(1).max(320), // an email or the optional username alias
});
export type LoginIdentifierInput = z.infer<typeof loginIdentifierSchema>;

export const signupSchema = z.object({
  email: z.string().email().max(320),
  fullName: z.string().min(1).max(255),
  username: usernameSchema.optional(),
  password: z.string().min(8).max(256),
});
export type SignupInput = z.infer<typeof signupSchema>;

// ── Cross-domain token exchange (ADR-0016) ───────────────────────────────────────────────────────────
export const tokenExchangeSchema = z.object({
  code: z.string().min(20).max(512),
  codeVerifier: z.string().min(43).max(128), // PKCE S256 verifier
  state: z.string().min(1).max(256),
});
export type TokenExchangeInput = z.infer<typeof tokenExchangeSchema>;

export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** Claims carried by the short-lived access JWT (validated by apps/api via JWKS). */
export const accessTokenClaimsSchema = z.object({
  sub: z.string().uuid(), // user id
  tid: z.string().uuid(), // tenant id
  wid: z.string().uuid().optional(), // active workspace id (absent until selected)
  sid: z.string(), // session id (for the revocation denylist)
  scope: z.array(z.string()).default([]),
  pa: z.boolean().optional(), // platform super-admin — cross-tenant access (ADR-0032)
  iss: z.string(),
  aud: z.string(),
  exp: z.number(),
  iat: z.number(),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

// ── Auth audit (Auth Admin ▸ Security view) — a shaped auth event (no metadata/userAgent); occurredAt ISO ──
export const authAuditEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  actorUserId: z.string().uuid().nullable(),
  ipAddress: z.string().nullable(),
  originDomain: z.string().nullable(),
  occurredAt: z.string(),
});
export type AuthAuditEntry = z.infer<typeof authAuditEntrySchema>;

// ── Auth policy (ADR-0018; strictest-wins resolution lives in packages/auth) ─────────────────────────
// The TENANT-EDITABLE policy contract (the org's security_admin PUTs this). The per-tenant enforcement
// master switch (enforcement_enabled) is deliberately NOT here — it is staff-only (set via the platform
// admin endpoint), so a tenant can never self-enable the lockout-capable gates through its own policy PUT.
export const authPolicySchema = z.object({
  mfaEnforcement: mfaEnforcement,
  allowedMethods: z.array(authMethod),
  disableSocial: z.boolean().default(false),
  requireSso: z.boolean().default(false),
  ipAllowlist: z.array(z.string()).default([]), // CIDR strings; empty = no restriction
  sessionTimeoutSeconds: z.number().int().positive().optional(), // ABSOLUTE session-lifetime cap (P1-01 Gate D)
  idleTimeoutSeconds: z.number().int().positive().optional(), // IDLE-window cap, enforced on refresh (Gate D)
  // Max simultaneous active sessions per user (AUTH-042). Unset = unlimited; a smaller value is STRICTER
  // (min-wins across scopes, like the timeout caps). Enforced at session creation (evict the oldest over cap).
  maxConcurrentSessions: z.number().int().positive().optional(),
});
export type AuthPolicy = z.infer<typeof authPolicySchema>;

// ── Platform-staff auth-enforcement toggle (P1-01) — set/clear a tenant's per-tenant enforcement master
// switch. STAFF-ONLY (super_admin); the disable direction IS the break-glass that re-opens login without a
// deploy. Carried as its own minimal schema so it never rides the tenant-editable authPolicySchema. ──────
export const setAuthEnforcementSchema = z.object({
  enabled: z.boolean(),
});
export type SetAuthEnforcementInput = z.infer<typeof setAuthEnforcementSchema>;

// ── Admin session management (G-AUTH-2, 17 §5/§10) ───────────────────────────────────────────────────
// Workspace admins (owner|admin) can list the active sessions of the members of their workspace and revoke
// one, or force a member to re-authenticate (revoke all of that member's sessions in this workspace). The
// session id is opaque (Lucia, not a uuid). No refresh-token/PII secrets are ever exposed — the list carries
// only the human-meaningful device/location/time signals (17 §10).

/** One active session row in the workspace-admin sessions table. */
export const adminSessionSchema = z.object({
  id: z.string(), // opaque session id (Lucia) — not a uuid
  userId: z.string().uuid(),
  userEmail: z.string().email(),
  userName: z.string().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(), // ISO-8601
  lastSeenAt: z.string().nullable(), // ISO-8601
  expiresAt: z.string(), // ISO-8601
  current: z.boolean(), // true if this is the requesting admin's own current session
});
export type AdminSession = z.infer<typeof adminSessionSchema>;

export const adminSessionListSchema = z.object({
  sessions: z.array(adminSessionSchema),
});
export type AdminSessionList = z.infer<typeof adminSessionListSchema>;

/** Path param for revoking a single session — the opaque session id. */
export const sessionIdParamSchema = z.object({
  sessionId: z.string().min(1).max(255),
});
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;

/** Path param for force-reauth — the target member's user id (uuid). */
export const memberIdParamSchema = z.object({
  userId: z.string().uuid(),
});
export type MemberIdParam = z.infer<typeof memberIdParamSchema>;

/** Result of a revoke / force-reauth call — how many active sessions were ended. */
export const sessionRevokeResultSchema = z.object({
  revoked: z.number().int().nonnegative(),
});
export type SessionRevokeResult = z.infer<typeof sessionRevokeResultSchema>;

// ── Workspace members management (P1-03; 12 §3, 17 §5) ───────────────────────────────────────────────
// A workspace owner|admin lists the members of their workspace and invites / re-roles / removes them. The
// row `id` is the membership row id for an active member, or the pending-invitation id for an invited one
// (the panel uses it opaquely as the row key + for the PATCH/DELETE target). Roles are validated against
// the closed `workspaceRole` enum; `owner` is never assignable here (transfer-of-ownership is its own flow),
// so the invite/role bodies accept only the non-owner roles.

/** A role that may be ASSIGNED via invite / role-change — every workspaceRole EXCEPT `owner`. */
export const assignableWorkspaceRole = z.enum(["admin", "member", "viewer"]);
export type AssignableWorkspaceRole = z.infer<typeof assignableWorkspaceRole>;

/** One row in the Workspace ▸ Members table. `id` is opaque to the client (membership row or invite id). */
export const workspaceMemberSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: workspaceRole,
  status: z.enum(["active", "invited"]),
  joinedAt: z.string().nullable(), // ISO-8601; null for a pending invite
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const workspaceMemberListSchema = z.object({
  members: z.array(workspaceMemberSchema),
});
export type WorkspaceMemberList = z.infer<typeof workspaceMemberListSchema>;

/** POST /members body — invite an email at an assignable (non-owner) role. */
export const inviteMemberSchema = z.object({
  email: z.string().email().max(320),
  role: assignableWorkspaceRole,
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

/** PATCH /members/:id body — change a member's role (never to `owner`). */
export const changeMemberRoleSchema = z.object({
  role: assignableWorkspaceRole,
});
export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleSchema>;

/** Path param for the member-scoped routes (PATCH/DELETE) — the opaque row id (membership or invite). */
export const workspaceMemberIdParamSchema = z.object({
  memberId: z.string().uuid(),
});
export type WorkspaceMemberIdParam = z.infer<typeof workspaceMemberIdParamSchema>;
