import type { DomainResolver } from "@leadwolf/auth";
// domainResolver.ts — the LIVE DomainResolver for progressive login (ADR-0017/0020): maps a verified email
// domain to its tenant + SSO routing + registration join policy via tenant_domains/tenant_sso_configs. Reads
// globally (pre-tenant) through the membership/routing repository.
import { tenantDomainRepository } from "@leadwolf/db";

export const resolveDomain: DomainResolver = (domain) =>
  tenantDomainRepository.findVerifiedByDomain(domain);
