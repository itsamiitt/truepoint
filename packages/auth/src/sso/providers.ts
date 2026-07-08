// providers.ts — SsoProvider selection + the real-protocol adapter seams (17 §7). Dev/test resolves to the
// mock IdP so the whole flow is exercisable; production resolves to the real OIDC/SAML adapter for the
// tenant's protocol. The two real adapters are deliberate, clearly-marked seams: their bodies are where
// `arctic` (OIDC: authorize URL → code exchange → id_token verify) and `@node-saml/node-saml` (SAML:
// AuthnRequest → ACS Response verify) get wired, behind the SAME interface the mock already satisfies.

import { env } from "@leadwolf/config";
import { mockProvider } from "./mockIdp.ts";
import type { SsoProvider } from "./types.ts";

const oidcUnwired =
  "OIDC SSO is not configured: wire `arctic` into packages/auth/src/sso/providers.ts";
const samlUnwired =
  "SAML SSO is not configured: wire `@node-saml/node-saml` into packages/auth/src/sso/providers.ts";

export const oidcProvider: SsoProvider = {
  protocol: "oidc",
  async initiate() {
    // Build the IdP authorize URL (PKCE verifier + nonce → providerState). Throws until the adapter lands.
    throw new Error(oidcUnwired);
  },
  async validate() {
    // Exchange the code, verify the id_token signature/claims, map attributes → SsoAssertion.
    throw new Error(oidcUnwired);
  },
};

export const samlProvider: SsoProvider = {
  protocol: "saml",
  async initiate() {
    // Build the SAML AuthnRequest redirect (RelayState = relayState). Throws until the adapter lands.
    throw new Error(samlUnwired);
  },
  async validate() {
    // Validate the signed SAML Response/assertion against the IdP metadata, map attributes → SsoAssertion.
    throw new Error(samlUnwired);
  },
};

/**
 * Resolve the provider for a protocol. Non-production uses the mock IdP (no external dependency), so the
 * handoff → callback → JIT path runs locally; production routes to the real adapter behind the same seam.
 */
export function getSsoProvider(protocol: "oidc" | "saml"): SsoProvider {
  if (env.NODE_ENV !== "production") return mockProvider;
  return protocol === "oidc" ? oidcProvider : samlProvider;
}

// The one place that records which production adapters are actually wired. Empty until `arctic` (OIDC) /
// `@node-saml/node-saml` (SAML) land — so in production BOTH resolve to a throwing stub. When you wire an
// adapter above, add its protocol here in the SAME change.
const WIRED_PROD_PROTOCOLS = new Set<"oidc" | "saml">();

/**
 * Is the resolved SSO provider FUNCTIONAL (not a throwing stub)? The no-lockout guard: an org must not be able to
 * enable `require_sso` while its provider would throw — forcing SSO with a dead adapter locks everyone out. Non-
 * production always runs the mock (fully functional); production is gated on `WIRED_PROD_PROTOCOLS`.
 */
export function isSsoProviderWired(protocol: "oidc" | "saml"): boolean {
  if (env.NODE_ENV !== "production") return true;
  return WIRED_PROD_PROTOCOLS.has(protocol);
}

/**
 * Pure no-lockout predicate (AUTH-031): `require_sso` may be enabled for a tenant ONLY if its SSO connection is
 * both ENABLED and backed by a WIRED provider. A null/disabled config, or an unwired (throwing-stub) provider,
 * returns false — the write path rejects the enforcement flip so an org can't lock itself out. Testable without I/O.
 */
export function ssoReadyForEnforcement(
  config: { enabled: boolean; protocol: "oidc" | "saml" } | null,
): boolean {
  return config != null && config.enabled && isSsoProviderWired(config.protocol);
}
