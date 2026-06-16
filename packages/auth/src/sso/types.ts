// types.ts — the protocol-agnostic SSO seam (ADR-0020 / 17 §7). One SsoProvider interface abstracts both
// OIDC and SAML so the flow (handoff → IdP → callback → JIT) is identical regardless of protocol, and the
// dev mock IdP, the real `arctic` (OIDC) adapter, and the real `@node-saml` adapter are interchangeable
// implementations behind it. SsoConfig is the decrypted view of a tenant_sso_configs row.

export interface SsoConfig {
  tenantId: string;
  protocol: "oidc" | "saml";
  provider: string;
  oidcIssuer?: string | null;
  oidcClientId?: string | null;
  oidcClientSecret?: string | null; // decrypted by the caller before reaching a provider
  metadataUrl?: string | null;
  metadataXml?: string | null;
  attributeMapping: Record<string, string>;
  jitEnabled: boolean;
  defaultRole: string;
  enforced: boolean;
}

/** What initiate() yields: where to send the browser, plus the per-request state the callback must echo. */
export interface SsoInitiation {
  redirectUrl: string;
  relayState: string; // CSRF nonce — OIDC `state` / SAML `RelayState`; persisted in the SSO transaction
  providerState?: string; // opaque (e.g. OIDC PKCE verifier + nonce) the provider needs again at validate()
}

/** A validated assertion from the IdP, normalized to the identity fields registration/JIT consume. */
export interface SsoAssertion {
  email: string;
  fullName?: string;
  attributes: Record<string, string>;
}

export interface SsoProvider {
  protocol: "oidc" | "saml";
  initiate(input: {
    config: SsoConfig;
    callbackUrl: string;
    emailHint?: string;
  }): Promise<SsoInitiation>;
  validate(input: {
    config: SsoConfig;
    params: Record<string, string>;
    relayState: string;
    providerState?: string;
  }): Promise<SsoAssertion>;
}
