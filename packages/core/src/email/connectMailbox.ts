// connectMailbox.ts — connect a sending mailbox (M12, email-planning/13 P0, 02, D7). Workspace-scoped. The
// LIVE credential (SMTP password or the OAuth token bundle from a completed OAuth flow) is encrypted at rest
// via the secretStore (KMS-envelope) and stored on mailbox_integration; it is NEVER returned, logged, or
// accepted back from a read. The connect is audited (`mailbox.connect`, IDs + provider/address only — never
// the secret). The full Google/Microsoft OAuth redirect dance (start/callback) is the P1 adapter's job; at
// P0 we accept the resulting token bundle (or an SMTP password) and prove the at-rest encryption end-to-end.

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
  /** OAuth token bundle (serialized) for a google/microsoft mailbox — server-side only. */
  oauthToken?: string;
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

    // Encrypt whichever credential the provider carries. `ses` mailboxes use the platform identity and carry
    // no per-mailbox credential, so neither field is set (markConnected stores nulls — still status=connected).
    const cred: { oauthTokenEnc?: Uint8Array; smtpSecretEnc?: Uint8Array } = {};
    if (input.smtpPassword) cred.smtpSecretEnc = encryptSecret(input.smtpPassword);
    if (input.oauthToken) cred.oauthTokenEnc = encryptSecret(input.oauthToken);
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
