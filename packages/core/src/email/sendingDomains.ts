// sendingDomains.ts — create + DNS-verify a per-tenant sending_domain (M12, email-planning/13 P0, 03 §1,
// D2). TENANT-scoped (a sending domain is a tenant asset). A domain is unusable for any send until SPF+DKIM+
// DMARC verify (the hard Gmail/Yahoo gate); verification runs the dnsAuth verifier (DI resolver — testable
// without a network) and writes the result via sendingDomainRepository.applyAuthState, which promotes status
// to 'verified' only when all three pass. Both mutations audit in-tx (`sending_domain.add` / `.verify`).

import {
  type DomainAuthState,
  type TenantScope,
  sendingDomainRepository,
  withTenantTx,
} from "@leadwolf/db";
import { NotFoundError } from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";
import { type DnsResolverPort, nodeDnsResolver, verifyDomainAuth } from "./dnsAuth.ts";

export interface CreateSendingDomainInput {
  scope: TenantScope;
  userId: string;
  domain: string;
  region?: string;
}

export async function createSendingDomain(
  input: CreateSendingDomainInput,
): Promise<{ id: string }> {
  return withTenantTx<{ id: string }>(input.scope, async (tx) => {
    const id = await sendingDomainRepository.insert(tx, {
      tenantId: input.scope.tenantId,
      domain: input.domain,
      region: input.region,
    });
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: null, // tenant-level: a sending domain is shared across the tenant's workspaces
      actorUserId: input.userId,
      action: "sending_domain.add",
      entityType: "sending_domain",
      entityId: id,
      metadata: { domain: input.domain },
    });
    return { id };
  });
}

export interface VerifySendingDomainInput {
  scope: TenantScope;
  userId: string;
  domainId: string;
  /** Injected for tests; defaults to the real node:dns resolver. */
  resolver?: DnsResolverPort;
}

export interface VerifySendingDomainResult extends DomainAuthState {
  status: "verified" | "failed";
}

export async function verifySendingDomain(
  input: VerifySendingDomainInput,
): Promise<VerifySendingDomainResult> {
  const resolver = input.resolver ?? nodeDnsResolver;
  return withTenantTx<VerifySendingDomainResult>(input.scope, async (tx) => {
    const domain = await sendingDomainRepository.getById(tx, input.domainId);
    if (!domain) throw new NotFoundError("Sending domain not found in this tenant.");

    const auth = await verifyDomainAuth(resolver, {
      domain: domain.domain,
      dkimSelector: null, // P0 checks SPF + DMARC; the DKIM selector is provisioned with the ESP adapter at P1
      trackingCname: domain.trackingCname,
    });
    await sendingDomainRepository.applyAuthState(tx, input.domainId, auth);

    const allPass =
      auth.spfState === "pass" && auth.dkimState === "pass" && auth.dmarcState === "pass";
    const status: VerifySendingDomainResult["status"] = allPass ? "verified" : "failed";

    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: null,
      actorUserId: input.userId,
      action: "sending_domain.verify",
      entityType: "sending_domain",
      entityId: input.domainId,
      metadata: {
        spf: auth.spfState,
        dkim: auth.dkimState,
        dmarc: auth.dmarcState,
        status,
      },
    });

    return { ...auth, status };
  });
}
