// connectMailbox.ts — connect an SMTP or platform-SES sending mailbox (M12, email-planning/13 P0/P1, 02, D7).
// Workspace-scoped. The LIVE SMTP credential is encrypted at rest via the secretStore (KMS-envelope) and stored
// on mailbox_integration; it is NEVER returned, logged, or accepted back from a read. The connect is audited
// (`mailbox.connect`, IDs + provider/address only — never the secret). Google/Microsoft mailboxes do NOT come
// through here — they use the OAuth redirect flow (mailboxConnectFlow.ts) so a raw token is never posted by the
// client; this path is only the credential (SMTP) / platform-identity (SES) providers.

import { type TenantScope, mailboxRepository, withTenantTx } from "@leadwolf/db";
import type { MailboxProvider } from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";
import { encryptSecret } from "./secretStore.ts";

export interface ConnectMailboxInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  provider: MailboxProvider;
  address: string;
  sendingDomainId?: string | null;
  /** SMTP mailbox credential — server-side only. */
  smtpPassword?: string;
}

export interface ConnectMailboxResult {
  id: string;
  status: "connected";
}

export async function connectMailbox(input: ConnectMailboxInput): Promise<ConnectMailboxResult> {
  return withTenantTx<ConnectMailboxResult>(input.scope, async (tx) => {
    const id = await mailboxRepository.insert(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      ownerUserId: input.userId,
      provider: input.provider,
      address: input.address,
      sendingDomainId: input.sendingDomainId ?? null,
    });

    // Encrypt the SMTP credential if present. `ses` mailboxes use the platform identity and carry no per-mailbox
    // credential, so the field is left unset (markConnected stores null — still status=connected).
    const cred: { smtpSecretEnc?: Uint8Array } = {};
    if (input.smtpPassword) cred.smtpSecretEnc = encryptSecret(input.smtpPassword);
    await mailboxRepository.markConnected(tx, id, cred);

    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.userId,
      action: "mailbox.connect",
      entityType: "mailbox_integration",
      entityId: id,
      metadata: { provider: input.provider, address: input.address }, // never the credential
    });

    return { id, status: "connected" };
  });
}
