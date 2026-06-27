// resolveSendingIdentity.ts — the per-tenant reputation-isolation gate for a real send (email-planning/13 P1,
// 07, D2/D3). Given the sequence's from-address, resolve the tenant's OWN connected mailbox and its
// DNS-verified sending domain — and REFUSE the send if either is missing. A tenant never sends through a
// shared TruePoint identity or an unverified domain (the unforgiving risk this phase front-loads, 13 §4).
// Pure data-access over the @leadwolf/db repositories; runs inside the caller's send-gate transaction.

import {
  type TenantScope,
  type Tx,
  mailboxRepository,
  sendingDomainRepository,
} from "@leadwolf/db";
import { ValidationError } from "@leadwolf/types";
import type { SendIdentity } from "./providerAdapter.ts";

/** The domain portion of an email address, lowercased. Empty when malformed. */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "";
}

/**
 * Resolve + verify the sending identity for `fromAddress` in this workspace. Throws ValidationError (→ 422,
 * never a silent send) when there is no connected mailbox for the address, or when its sending domain is not
 * DNS-verified (D2/D3). Run inside the send-gate tx so the check and the quota consume commit together.
 */
export async function resolveSendingIdentity(
  tx: Tx,
  scope: TenantScope & { workspaceId: string },
  fromAddress: string,
): Promise<SendIdentity> {
  const mailbox = await mailboxRepository.findConnectedByAddress(
    tx,
    scope.workspaceId,
    fromAddress,
  );
  if (!mailbox) {
    throw new ValidationError(
      `No connected mailbox for "${fromAddress}" — connect it before sending (D2).`,
    );
  }

  // The domain must be DNS-verified (SPF+DKIM+DMARC). Prefer the mailbox's bound sending_domain; otherwise
  // resolve a verified domain matching the from-address's domain. Either way an UNVERIFIED domain is refused.
  let verifiedDomain: string | null = null;
  if (mailbox.sendingDomainId) {
    const domain = await sendingDomainRepository.getById(tx, mailbox.sendingDomainId);
    if (domain && domain.status === "verified") verifiedDomain = domain.domain;
  } else {
    const domain = await sendingDomainRepository.findVerified(tx, domainOf(fromAddress));
    if (domain) verifiedDomain = domain.domain;
  }

  if (!verifiedDomain) {
    throw new ValidationError(
      `Sending domain for "${fromAddress}" is not DNS-verified (SPF/DKIM/DMARC) — verify it before sending (D2/D3).`,
    );
  }

  return {
    provider: mailbox.provider as SendIdentity["provider"],
    fromAddress,
    sendingDomain: verifiedDomain,
    mailboxId: mailbox.id,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  };
}
