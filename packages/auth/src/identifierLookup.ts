// identifierLookup.ts — Step 1 of progressive login (ADR-0017): email → domain → routed Step-2, WITHOUT
// leaking whether the account exists. Routing is by VERIFIED domain only (never by user existence), so the
// response is identical for known and unknown accounts. Unclaimed/personal domains fall through to password.

import { identifierResultSchema, type IdentifierResult } from "@leadwolf/types";

export interface DomainRouting {
  tenantId: string;
  tenantName: string;
  ssoEnforced: boolean;
  ssoProvider?: "saml" | "oidc";
}

/** Resolve a verified domain → tenant SSO routing, or null if unclaimed. Injected to keep this pure and
 *  testable; the live resolver reads tenant_domains + tenant_sso_configs via repositories. */
export type DomainResolver = (domain: string) => Promise<DomainRouting | null>;

export async function lookupIdentifier(
  email: string,
  resolveDomain: DomainResolver,
): Promise<IdentifierResult> {
  const at = email.lastIndexOf("@");
  const domain = at >= 0 ? email.slice(at + 1).toLowerCase() : "";
  const routing = domain ? await resolveDomain(domain) : null;

  if (routing?.ssoEnforced) {
    return identifierResultSchema.parse({
      method: "sso",
      tenantId: routing.tenantId,
      tenantName: routing.tenantName,
      ssoProvider: routing.ssoProvider,
    });
  }
  if (routing) {
    return identifierResultSchema.parse({
      method: "password",
      tenantId: routing.tenantId,
      tenantName: routing.tenantName,
    });
  }
  // Unclaimed / personal domain: render password (with social + magic-link also offered on the screen).
  return identifierResultSchema.parse({ method: "password" });
}
