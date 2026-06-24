// mailboxRepository.ts — data access for mailbox_integration (M12 email, email-planning/13 P0, 02, D7).
// WORKSPACE-scoped (a connected mailbox belongs to a user in a workspace). Credentials (oauth_token_enc /
// smtp_secret_enc) are written as KMS-envelope ciphertext by core/email/secretStore and NEVER read back into
// a DTO here — only the send adapter decrypts them, server-side (D7). The list/getById selects deliberately
// OMIT the *_enc columns so a credential can never leak through the API. Mirrors outreachLogRepository.

import { desc, eq, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { mailboxIntegration } from "../schema/email.ts";

export interface MailboxInsert {
  tenantId: string;
  workspaceId: string;
  ownerUserId: string;
  provider: string; // google | microsoft | smtp | ses
  address: string;
  sendingDomainId?: string | null;
}

/** Safe projection — NEVER includes the encrypted credential columns (D7). */
export interface MailboxRecord {
  id: string;
  ownerUserId: string | null;
  provider: string;
  address: string;
  sendingDomainId: string | null;
  status: string;
  lastError: string | null;
  connectedAt: Date | null;
}

const safeColumns = {
  id: mailboxIntegration.id,
  ownerUserId: mailboxIntegration.ownerUserId,
  provider: mailboxIntegration.provider,
  address: mailboxIntegration.address,
  sendingDomainId: mailboxIntegration.sendingDomainId,
  status: mailboxIntegration.status,
  lastError: mailboxIntegration.lastError,
  connectedAt: mailboxIntegration.connectedAt,
};

export const mailboxRepository = {
  /** Create a pending mailbox row. The encrypted credential is attached by markConnected after the OAuth/SMTP
   * exchange — never accepted from the client. UNIQUE(workspace_id, address) prevents a double-connect. */
  async insert(tx: Tx, row: MailboxInsert): Promise<string> {
    const inserted = await tx
      .insert(mailboxIntegration)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        ownerUserId: row.ownerUserId,
        provider: row.provider,
        address: row.address,
        sendingDomainId: row.sendingDomainId ?? null,
      })
      .returning({ id: mailboxIntegration.id });
    return inserted[0]!.id;
  },

  async getById(tx: Tx, mailboxId: string): Promise<MailboxRecord | null> {
    const rows = await tx
      .select(safeColumns)
      .from(mailboxIntegration)
      .where(eq(mailboxIntegration.id, mailboxId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Newest-first list for the workspace (the Mailboxes settings read). Never returns credentials. RLS-scoped. */
  async listByWorkspace(scope: TenantScope): Promise<MailboxRecord[]> {
    return withTenantTx(scope, (tx) =>
      tx.select(safeColumns).from(mailboxIntegration).orderBy(desc(mailboxIntegration.createdAt)),
    );
  },

  /**
   * Attach the KMS-envelope-encrypted credential and mark connected. The ciphertext is produced by
   * core/email/secretStore server-side; this is the ONLY write path for the *_enc columns. Exactly one of
   * oauthTokenEnc / smtpSecretEnc is set per the provider.
   */
  async markConnected(
    tx: Tx,
    mailboxId: string,
    cred: { oauthTokenEnc?: Uint8Array; smtpSecretEnc?: Uint8Array },
  ): Promise<void> {
    await tx
      .update(mailboxIntegration)
      .set({
        oauthTokenEnc: cred.oauthTokenEnc ?? null,
        smtpSecretEnc: cred.smtpSecretEnc ?? null,
        status: "connected",
        lastError: null,
        connectedAt: sql`now()`,
      })
      .where(eq(mailboxIntegration.id, mailboxId));
  },

  /** Record a connect/refresh failure (status='error') without touching the credential columns. */
  async markError(tx: Tx, mailboxId: string, message: string): Promise<void> {
    await tx
      .update(mailboxIntegration)
      .set({ status: "error", lastError: message.slice(0, 500) })
      .where(eq(mailboxIntegration.id, mailboxId));
  },
};
