// sso.ts — the tenant SSO (SAML / OIDC) configuration contract (17 §7, ADR-0017/0018). The MASKED view sent
// to the Auth Admin ▸ Single sign-on panel (NEVER the OIDC client secret) + the update mutation body. Single
// source of truth shared by apps/api (validates the PUT) and apps/web (derives its form types). The client
// secret is write-only: `hasClientSecret` indicates whether one is stored; the bytes never leave the server.

import { z } from "zod";

export const ssoProtocol = z.enum(["saml", "oidc"]);
export type SsoProtocol = z.infer<typeof ssoProtocol>;

// The granular org roles a JIT-provisioned SSO user may be granted (mirrors @leadwolf/types orgRole).
export const ssoDefaultRole = z.enum([
  "owner",
  "billing_admin",
  "security_admin",
  "compliance_admin",
  "member",
]);
export type SsoDefaultRole = z.infer<typeof ssoDefaultRole>;

/** The masked SSO config shown in the admin panel. `hasClientSecret` is a boolean indicator — never the secret. */
export const ssoConfigViewSchema = z.object({
  protocol: ssoProtocol,
  provider: z.string(),
  metadataUrl: z.string().nullable(),
  oidcIssuer: z.string().nullable(),
  oidcClientId: z.string().nullable(),
  attributeMapping: z.record(z.string()),
  jitEnabled: z.boolean(),
  defaultRole: z.string(),
  enabled: z.boolean(),
  enforced: z.boolean(),
  hasClientSecret: z.boolean(),
});
export type SsoConfigView = z.infer<typeof ssoConfigViewSchema>;

/** The SSO config update body (PUT). The OIDC client secret is write-only and optional — when absent the
 *  stored secret is left unchanged; when present it is encrypted server-side, never echoed back. */
export const ssoConfigUpdateSchema = z.object({
  protocol: ssoProtocol,
  provider: z.string().min(1).max(50),
  metadataUrl: z.string().url().max(2048).nullish(),
  metadataXml: z.string().max(100_000).nullish(),
  oidcIssuer: z.string().url().max(2048).nullish(),
  oidcClientId: z.string().max(255).nullish(),
  oidcClientSecret: z.string().min(1).max(2048).optional(), // write-only; absent = leave unchanged
  attributeMapping: z.record(z.string()).optional(),
  jitEnabled: z.boolean().optional(),
  defaultRole: ssoDefaultRole.optional(),
  enabled: z.boolean().optional(),
  enforced: z.boolean().optional(),
});
export type SsoConfigUpdate = z.infer<typeof ssoConfigUpdateSchema>;
