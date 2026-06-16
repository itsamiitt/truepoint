// identifierLookup.ts — Step 1 of progressive login (ADR-0017/0020). Resolves an email OR username to a
// global identity and REVEALS whether it exists to branch login vs registration. For an existing identity it
// routes by the canonical email's verified domain (SSO when enforced) else password/magic; unknown → register.
// The credential step stays uniform — only this step reveals existence (gated by Turnstile + rate-limit).

import { userRepository } from "@leadwolf/db";
import { type IdentifierResult, identifierResultSchema } from "@leadwolf/types";

export interface DomainRouting {
  tenantId: string;
  tenantName: string;
  joinPolicy: string; // sso_only | auto_join | request_access
  ssoEnforced: boolean;
  ssoProtocol: string | null; // saml | oidc
}

/** Resolve a verified email domain → tenant + SSO routing, or null if unclaimed. Injected for testability;
 *  the live resolver reads tenant_domains + tenant_sso_configs (apps/auth/lib/domainResolver). */
export type DomainResolver = (domain: string) => Promise<DomainRouting | null>;

/** Resolve an email/username to the global identity (only the fields the routing reads). Injected — defaults
 *  to the live repo — so the routing is unit-testable WITHOUT importing the DB module (which opens a postgres
 *  pool at import); a bun mock.module of @leadwolf/db is global and would leak across the whole suite. */
export type UserLookup = (
  identifier: string,
) => Promise<{ email: string; passwordHash: string | null } | null>;

export async function lookupIdentifier(
  identifier: string,
  resolveDomain: DomainResolver,
  findUser: UserLookup = userRepository.findByEmailOrUsername,
): Promise<IdentifierResult> {
  const id = identifier.trim();
  const user = await findUser(id);

  // Canonical email: an existing identity's email, or the identifier itself if it was an email.
  const email = user ? user.email : id.includes("@") ? id.toLowerCase() : null;
  const at = email ? email.lastIndexOf("@") : -1;
  const domain = at >= 0 ? email!.slice(at + 1).toLowerCase() : "";
  const routing = domain ? await resolveDomain(domain) : null;

  // SSO-enforced domain wins for everyone on it — existing OR first-time (the callback JIT-provisions the
  // new identity). This is checked BEFORE the unknown→register branch so SSO users never hit registration.
  if (routing?.ssoEnforced) {
    return identifierResultSchema.parse({
      route: "sso",
      email: email ?? undefined,
      tenantId: routing.tenantId,
      tenantName: routing.tenantName,
      ssoProvider: routing.ssoProtocol === "oidc" ? "oidc" : "saml",
    });
  }

  // Unknown identity (and not an SSO domain) → registration. Carry the email if the identifier was one.
  if (!user) {
    return identifierResultSchema.parse({ route: "register", email: email ?? undefined });
  }
  if (user.passwordHash) {
    return identifierResultSchema.parse({ route: "password", email: user.email });
  }
  // No password set → passwordless (magic link).
  return identifierResultSchema.parse({ route: "magic", email: user.email });
}
