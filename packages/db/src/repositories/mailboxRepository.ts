// mailboxRepository.ts — data access for mailbox_integration (M12 email, email-planning/13 P0, 02, D7).
// WORKSPACE-scoped (a connected mailbox belongs to a user in a workspace). Credentials (oauth_token_enc /
// smtp_secret_enc) are written as KMS-envelope ciphertext by core/email/secretStore and NEVER read back into
// a DTO here — only the send adapter decrypts them, server-side (D7). The list/getById selects deliberately
// OMIT the *_enc columns so a credential can never leak through the API. Mirrors outreachLogRepository.

import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { type TenantScope, type Tx, db, withTenantTx } from "../client.ts";
import { mailboxIntegration } from "../schema/email.ts";

/** The proactive-refresh worklist row — ids only, NEVER a credential (the decrypt is tenant-scoped per mailbox). */
export interface MailboxDueRow {
  id: string;
  tenantId: string;
  workspaceId: string;
}

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
   * oauthTokenEnc / smtpSecretEnc is set per the provider. The OAuth lifecycle metadata (expiry/scopes/account
   * id) is kept in CLEAR so the refresh worker acts without decrypting the bundle (D7 — the tokens stay
   * encrypted). A (re)connect clears any prior reauth flag.
   */
  async markConnected(
    tx: Tx,
    mailboxId: string,
    cred: {
      oauthTokenEnc?: Uint8Array;
      smtpSecretEnc?: Uint8Array;
      oauthExpiresAt?: Date | null;
      oauthScopes?: string[] | null;
      providerAccountId?: string | null;
    },
  ): Promise<void> {
    await tx
      .update(mailboxIntegration)
      .set({
        oauthTokenEnc: cred.oauthTokenEnc ?? null,
        smtpSecretEnc: cred.smtpSecretEnc ?? null,
        oauthExpiresAt: cred.oauthExpiresAt ?? null,
        oauthScopes: cred.oauthScopes ?? null,
        providerAccountId: cred.providerAccountId ?? null,
        reauthRequired: false,
        reauthReason: null,
        status: "connected",
        lastError: null,
        connectedAt: sql`now()`,
      })
      .where(eq(mailboxIntegration.id, mailboxId));
  },

  /**
   * Read the ENCRYPTED OAuth credential + its lifecycle for a send (the D7-sanctioned server-side read-back —
   * ONLY the send adapter's token loader calls this; it is NEVER projected into an API response). Tenant/
   * workspace-scoped via RLS (run inside withTenantTx). Returns the ciphertext + clear expiry/reauth state so
   * the loader decides refresh-vs-use without a second round-trip.
   */
  async getTokenBundle(
    tx: Tx,
    mailboxId: string,
  ): Promise<{
    provider: string;
    oauthTokenEnc: Uint8Array | null;
    oauthExpiresAt: Date | null;
    reauthRequired: boolean;
  } | null> {
    const rows = await tx
      .select({
        provider: mailboxIntegration.provider,
        oauthTokenEnc: mailboxIntegration.oauthTokenEnc,
        oauthExpiresAt: mailboxIntegration.oauthExpiresAt,
        reauthRequired: mailboxIntegration.reauthRequired,
      })
      .from(mailboxIntegration)
      .where(eq(mailboxIntegration.id, mailboxId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Rotate the OAuth bundle after a successful refresh (new access token + expiry). Never touches scopes /
   * provider identity / connected status — a refresh is a credential roll, not a reconnect. */
  async updateOAuthToken(
    tx: Tx,
    mailboxId: string,
    oauthTokenEnc: Uint8Array,
    oauthExpiresAt: Date | null,
  ): Promise<void> {
    await tx
      .update(mailboxIntegration)
      .set({ oauthTokenEnc, oauthExpiresAt })
      .where(eq(mailboxIntegration.id, mailboxId));
  },

  /**
   * Mailboxes whose OAuth access token expires within `withinMs` — the proactive-refresh worklist (M12 P1). Runs
   * on the OWNER connection (cross-tenant maintenance sweep, BYPASSRLS — like the retention/backfill sweeps and
   * oauthConnectStateRepository.consume); the projection is ids ONLY (no credential). The actual refresh+rotate
   * per mailbox is tenant-SCOPED via getMailboxAccessToken (→ withTenantTx), so the decrypt stays RLS-enforced.
   * Only google/microsoft mailboxes with a stored token and no pending reauth are returned.
   */
  async listDueForRefresh(withinMs: number, limit: number): Promise<MailboxDueRow[]> {
    return db
      .select({
        id: mailboxIntegration.id,
        tenantId: mailboxIntegration.tenantId,
        workspaceId: mailboxIntegration.workspaceId,
      })
      .from(mailboxIntegration)
      .where(
        and(
          inArray(mailboxIntegration.provider, ["google", "microsoft"]),
          isNotNull(mailboxIntegration.oauthTokenEnc),
          eq(mailboxIntegration.reauthRequired, false),
          isNotNull(mailboxIntegration.oauthExpiresAt),
          lte(
            mailboxIntegration.oauthExpiresAt,
            sql`now() + (${withinMs}::text || ' milliseconds')::interval`,
          ),
        ),
      )
      .orderBy(asc(mailboxIntegration.oauthExpiresAt))
      .limit(limit);
  },

  /** Record a connect/refresh failure (status='error') without touching the credential columns. */
  async markError(tx: Tx, mailboxId: string, message: string): Promise<void> {
    await tx
      .update(mailboxIntegration)
      .set({ status: "error", lastError: message.slice(0, 500) })
      .where(eq(mailboxIntegration.id, mailboxId));
  },

  /** Flag a mailbox as needing re-auth (e.g. invalid_grant on refresh/send) — keeps the row + send-history and
   * drives the "Reconnect" UX. The stale credential is left in place; only a fresh OAuth grant clears it. */
  async markReauthRequired(tx: Tx, mailboxId: string, reason: string): Promise<void> {
    await tx
      .update(mailboxIntegration)
      .set({
        reauthRequired: true,
        reauthReason: reason.slice(0, 120),
        status: "error",
        lastError: reason.slice(0, 500),
      })
      .where(eq(mailboxIntegration.id, mailboxId));
  },

  /** Resolve the mailbox id for a (workspace, address) regardless of status — the OAuth-connect UPSERT key, so a
   * re-auth updates the existing row in place instead of colliding on UNIQUE(workspace_id, address). */
  async findIdByWorkspaceAddress(
    tx: Tx,
    workspaceId: string,
    address: string,
  ): Promise<string | null> {
    const rows = await tx
      .select({ id: mailboxIntegration.id })
      .from(mailboxIntegration)
      .where(
        and(
          eq(mailboxIntegration.workspaceId, workspaceId),
          eq(mailboxIntegration.address, address),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  },

  /**
   * Resolve the CONNECTED mailbox a send goes through, by its from-address (P1 send-gate identity resolution).
   * Workspace-scoped; only a 'connected' mailbox is returned. Null when there is no connected mailbox for the
   * address — the send is then refused (a tenant sends only from its own connected identity, D2). No credential.
   */
  async findConnectedByAddress(
    tx: Tx,
    workspaceId: string,
    address: string,
  ): Promise<MailboxRecord | null> {
    const rows = await tx
      .select(safeColumns)
      .from(mailboxIntegration)
      .where(
        and(
          eq(mailboxIntegration.workspaceId, workspaceId),
          eq(mailboxIntegration.address, address),
          eq(mailboxIntegration.status, "connected"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
};
