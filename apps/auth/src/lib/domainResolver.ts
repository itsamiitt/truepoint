// domainResolver.ts — the live DomainResolver for progressive login (ADR-0017): maps a verified email
// domain → its tenant + SSO routing. Wires to tenant_domains/tenant_sso_configs once those repositories
// land; today it returns null (unclaimed), so every domain routes to password / social / magic-link.
import type { DomainResolver } from "@leadwolf/auth";

export const resolveDomain: DomainResolver = async (_domain) => null;
