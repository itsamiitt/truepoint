// identityProvisioning.ts — the contract for the Tenant ▸ Security ▸ Domains & SCIM surface (enterprise IAM,
// 17 / ADR-0017/0018). Single source of truth shared by apps/api (the /settings/security/identity routes),
// packages/db (the repositories), and apps/web (the IdentityPanel). Validation lives here; the write logic
// lives in the API + repositories. Two domains:
//   • Domain claiming — an org claims a DNS domain, verifies it (DNS TXT, WIRE-deferred), and sets the
//     join policy for users at that domain. Reuses the existing `tenant_domains` table + its join_policy enum.
//   • SCIM tokens — long-lived bearer tokens the org's IdP uses to call SCIM 2.0. The plaintext token is
//     returned ONCE on create (scimTokenCreatedSchema); the list view (scimTokenViewSchema) never carries it.

import { z } from "zod";

// ── Domain claiming ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The join policy for a verified domain (mirrors tenant_domains.join_policy — workspaceRepository's
 * DomainResolution). `sso_only`: users at this domain must use SSO; `auto_join`: a fresh signup at this
 * domain auto-joins the org; `request_access`: signup creates a pending request an admin approves.
 */
export const joinPolicy = z.enum(["sso_only", "auto_join", "request_access"]);
export type JoinPolicy = z.infer<typeof joinPolicy>;

/** The lifecycle of a claimed domain (mirrors tenant_domains.status). */
export const domainStatus = z.enum(["pending", "verified", "failed"]);
export type DomainStatus = z.infer<typeof domainStatus>;

// A hostname (no scheme, no path) — lowercased, dot-separated labels. The server is the boundary; this is
// the edge validation an attacker-supplied value must pass before it ever reaches a query or a DNS lookup.
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;

/** The POST body that claims a domain. */
export const domainClaimSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .regex(HOSTNAME, "Enter a valid domain (e.g. acme.com)."),
});
export type DomainClaim = z.infer<typeof domainClaimSchema>;

/** The list/read view of a claimed domain (timestamps serialized as ISO strings over the wire). */
export const domainViewSchema = z.object({
  id: z.string().uuid(),
  domain: z.string(),
  status: domainStatus,
  joinPolicy,
  verifiedAt: z.string().nullable(),
});
export type DomainView = z.infer<typeof domainViewSchema>;

// ── SCIM tokens ──────────────────────────────────────────────────────────────────────────────────────────

/** The masked list/read view of a SCIM token — NEVER the token value or its hash. */
export const scimTokenViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ScimTokenView = z.infer<typeof scimTokenViewSchema>;

/** The POST body that mints a SCIM token. */
export const createScimTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type CreateScimToken = z.infer<typeof createScimTokenSchema>;

/**
 * The create RESPONSE — the only time the plaintext `token` is ever returned. The client must surface it
 * once and the server must not be able to recover it again (only the SHA-256 hash is stored).
 */
export const scimTokenCreatedSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  token: z.string(),
});
export type ScimTokenCreated = z.infer<typeof scimTokenCreatedSchema>;
