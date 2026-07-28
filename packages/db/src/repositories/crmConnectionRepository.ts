// crmConnectionRepository.ts — data access for crm_connections (crm-sync 00 §4.1 / §5.3 / §7.2).
// WORKSPACE-scoped under FORCE RLS (rls/crm.sql); every tenant-facing call runs inside withTenantTx.
//
// THE CREDENTIAL DISCIPLINE, which is the whole reason this file is shaped the way it is (mirrors
// mailboxRepository):
//   - `safeColumns` OMITS oauth_token_enc. Every list/get returns that projection, so the ciphertext cannot
//     reach a DTO, a log line, or an API response by accident — omission is the default, not a filter
//     someone has to remember to apply.
//   - `markConnected` is the ONLY write path for oauth_token_enc, and `rotateToken` the only updater.
//   - `getEncryptedBundle` is the ONLY read of it, is named to be conspicuous in review, and is called
//     exclusively by the worker that is about to call the CRM.
//   - `markError` records a failure WITHOUT touching the credential — a transient provider error must not
//     destroy a valid refresh token.
//
// The non-secret OAuth lifecycle metadata (token_expires_at, scopes, external_account_id, instance_url) is
// kept in CLEAR columns so the refresh sweep decides refresh-vs-use without decrypting anything.

import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { type TenantScope, type Tx, db, withTenantTx } from "../client.ts";
import { crmConnections } from "../schema/crm.ts";

/** Safe projection — NEVER includes oauth_token_enc (00 §7.2). */
export interface CrmConnectionRecord {
  id: string;
  ownerUserId: string | null;
  provider: string;
  status: string;
  syncMode: string;
  environment: string;
  externalAccountId: string | null;
  instanceUrl: string | null;
  tokenExpiresAt: Date | null;
  scopes: unknown;
  nextPollAt: Date | null;
  lastError: string | null;
  lastRefreshAt: Date | null;
  connectedAt: Date | null;
}

const safeColumns = {
  id: crmConnections.id,
  ownerUserId: crmConnections.ownerUserId,
  provider: crmConnections.provider,
  status: crmConnections.status,
  syncMode: crmConnections.syncMode,
  environment: crmConnections.environment,
  externalAccountId: crmConnections.externalAccountId,
  instanceUrl: crmConnections.instanceUrl,
  tokenExpiresAt: crmConnections.tokenExpiresAt,
  scopes: crmConnections.scopes,
  nextPollAt: crmConnections.nextPollAt,
  lastError: crmConnections.lastError,
  lastRefreshAt: crmConnections.lastRefreshAt,
  connectedAt: crmConnections.connectedAt,
};

export interface CrmConnectionInsert {
  tenantId: string;
  workspaceId: string;
  ownerUserId: string;
  provider: string; // salesforce | hubspot
  environment?: "production" | "sandbox";
}

/** The refresh-sweep worklist row — ids + scope ONLY, never a credential. */
export interface CrmConnectionDueRow {
  id: string;
  tenantId: string;
  workspaceId: string;
  provider: string;
}

export const crmConnectionRepository = {
  /**
   * Create a PENDING connection row. The encrypted bundle is attached by `markConnected` after the OAuth
   * code exchange — never accepted from the client, which is why this insert takes no credential argument
   * at all rather than an optional one.
   *
   * external_account_id stays null until the exchange resolves it; the workspace/provider/account unique
   * index is partial on `external_account_id IS NOT NULL` precisely so concurrent pre-connect rows do not
   * collide before anyone knows which CRM org they point at.
   */
  async insert(tx: Tx, row: CrmConnectionInsert): Promise<string> {
    const inserted = await tx
      .insert(crmConnections)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        ownerUserId: row.ownerUserId,
        provider: row.provider,
        environment: row.environment ?? "production",
      })
      .returning({ id: crmConnections.id });
    return inserted[0]!.id;
  },

  /**
   * Resolve the existing connection for a (workspace, provider, CRM account), regardless of status — the
   * OAuth-connect UPSERT key.
   *
   * Without this a re-auth INSERTs a second row and collides on
   * uniq_crm_connections_ws_provider_account, which is a partial unique index on
   * (workspace_id, provider, external_account_id) WHERE external_account_id IS NOT NULL. The index is
   * right — one live connection per workspace per CRM org — so the connect flow is what has to look first
   * and update in place. Mirrors mailboxRepository.findIdByWorkspaceAddress, which exists for the same
   * reason on the mailbox OAuth path.
   *
   * Note the ordering this implies for callers: the account id is only known AFTER the token exchange, so
   * the lookup necessarily happens post-exchange rather than at the start of the flow.
   */
  async findIdByWorkspaceProviderAccount(
    tx: Tx,
    workspaceId: string,
    provider: string,
    externalAccountId: string,
  ): Promise<string | null> {
    const rows = await tx
      .select({ id: crmConnections.id })
      .from(crmConnections)
      .where(
        and(
          eq(crmConnections.workspaceId, workspaceId),
          eq(crmConnections.provider, provider),
          eq(crmConnections.externalAccountId, externalAccountId),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  },

  async getById(tx: Tx, connectionId: string): Promise<CrmConnectionRecord | null> {
    const rows = await tx
      .select(safeColumns)
      .from(crmConnections)
      .where(eq(crmConnections.id, connectionId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Every connection in the workspace (the CRM settings read). Never returns a credential. RLS-scoped. */
  async listByWorkspace(scope: TenantScope): Promise<CrmConnectionRecord[]> {
    return withTenantTx(scope, (tx) =>
      tx.select(safeColumns).from(crmConnections).orderBy(asc(crmConnections.createdAt)),
    );
  },

  /**
   * Attach the encrypted OAuth bundle and mark connected. The ciphertext is produced by
   * core/crm/crmSecretStore server-side; this is the ONLY write path for oauth_token_enc.
   *
   * sync_mode is deliberately NOT set here. A (re)connect must never silently promote a connection to
   * `enforce` — the dark-launch gate is flipped by an explicit, audited operator action (00 §4.1), so a
   * reconnect of an enforcing connection keeps enforcing and a fresh one stays in `shadow`.
   */
  async markConnected(
    tx: Tx,
    connectionId: string,
    cred: {
      oauthTokenEnc: Uint8Array;
      tokenExpiresAt?: Date | null;
      scopes?: string[] | null;
      externalAccountId?: string | null;
      instanceUrl?: string | null;
    },
  ): Promise<void> {
    await tx
      .update(crmConnections)
      .set({
        oauthTokenEnc: cred.oauthTokenEnc,
        tokenExpiresAt: cred.tokenExpiresAt ?? null,
        scopes: cred.scopes ?? [],
        externalAccountId: cred.externalAccountId ?? null,
        instanceUrl: cred.instanceUrl ?? null,
        status: "connected",
        lastError: null,
        connectedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(crmConnections.id, connectionId));
  },

  /**
   * Read the ENCRYPTED bundle for a CRM call — the sanctioned server-side read-back. Named to be
   * conspicuous: a reviewer seeing this identifier should expect a decrypt nearby, and should expect it in
   * a worker rather than a route handler. Tenant/workspace-scoped via RLS (run inside withTenantTx).
   *
   * Returns the ciphertext alongside the CLEAR lifecycle columns so the caller decides refresh-vs-use in
   * one round-trip.
   */
  async getEncryptedBundle(
    tx: Tx,
    connectionId: string,
  ): Promise<{
    provider: string;
    status: string;
    syncMode: string;
    instanceUrl: string | null;
    oauthTokenEnc: Uint8Array | null;
    tokenExpiresAt: Date | null;
  } | null> {
    const rows = await tx
      .select({
        provider: crmConnections.provider,
        status: crmConnections.status,
        syncMode: crmConnections.syncMode,
        instanceUrl: crmConnections.instanceUrl,
        oauthTokenEnc: crmConnections.oauthTokenEnc,
        tokenExpiresAt: crmConnections.tokenExpiresAt,
      })
      .from(crmConnections)
      .where(eq(crmConnections.id, connectionId))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Rotate the bundle after a successful refresh. Touches the credential, its expiry and last_refresh_at and
   * NOTHING else — a refresh is a credential roll, not a reconnect, so status/scopes/account identity are
   * left exactly as the connect established them.
   */
  async rotateToken(
    tx: Tx,
    connectionId: string,
    oauthTokenEnc: Uint8Array,
    tokenExpiresAt: Date | null,
  ): Promise<void> {
    await tx
      .update(crmConnections)
      .set({
        oauthTokenEnc,
        tokenExpiresAt,
        lastRefreshAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(crmConnections.id, connectionId));
  },

  /**
   * Record a connect/sync/refresh failure WITHOUT touching the credential columns.
   *
   * Leaving the credential in place is the point: a 500 from the provider, a network blip or an expired
   * access token must not destroy a still-valid refresh token. Only an explicit reconnect replaces it.
   */
  async markError(tx: Tx, connectionId: string, message: string): Promise<void> {
    await tx
      .update(crmConnections)
      .set({
        status: "error",
        lastError: message.slice(0, 500),
        updatedAt: sql`now()`,
      })
      .where(eq(crmConnections.id, connectionId));
  },

  /**
   * Flip the dark-launch gate (00 §4.1 L3). Separate from every other mutation on purpose: promoting a
   * connection to `enforce` is the moment data starts leaving the tenant, so it is one explicit call that
   * the API layer gates on an admin role and audits (`crm.connect` / a mode-change audit row), never a
   * field folded into a general-purpose update.
   */
  async setSyncMode(
    tx: Tx,
    connectionId: string,
    syncMode: "disabled" | "shadow" | "enforce",
  ): Promise<void> {
    await tx
      .update(crmConnections)
      .set({ syncMode, updatedAt: sql`now()` })
      .where(eq(crmConnections.id, connectionId));
  },

  /** Advance the sweep cursor after a poll, so the next sweep skips this connection until it is due again. */
  async setNextPollAt(tx: Tx, connectionId: string, nextPollAt: Date): Promise<void> {
    await tx
      .update(crmConnections)
      .set({ nextPollAt, updatedAt: sql`now()` })
      .where(eq(crmConnections.id, connectionId));
  },

  /**
   * Connections whose access token expires within `withinMs` — the proactive-refresh worklist.
   *
   * Runs on the OWNER connection (a cross-tenant maintenance sweep, BYPASSRLS — the shape
   * mailboxRepository.listDueForRefresh and the retention/backfill sweeps use). The projection is ids +
   * scope ONLY: no credential ever appears in a cross-tenant result set. The actual refresh is then done
   * per connection under withTenantTx, so the decrypt itself stays RLS-enforced.
   */
  async listDueForRefresh(withinMs: number, limit: number): Promise<CrmConnectionDueRow[]> {
    return db
      .select({
        id: crmConnections.id,
        tenantId: crmConnections.tenantId,
        workspaceId: crmConnections.workspaceId,
        provider: crmConnections.provider,
      })
      .from(crmConnections)
      .where(
        and(
          eq(crmConnections.status, "connected"),
          isNotNull(crmConnections.oauthTokenEnc),
          isNotNull(crmConnections.tokenExpiresAt),
          lte(
            crmConnections.tokenExpiresAt,
            sql`now() + (${withinMs}::text || ' milliseconds')::interval`,
          ),
        ),
      )
      .orderBy(asc(crmConnections.tokenExpiresAt))
      .limit(limit);
  },

  /**
   * Connections the sweep should poll now — status connected AND (never polled OR due).
   *
   * Also the owner-path cross-tenant worklist, ids + scope only. `next_poll_at IS NULL` counts as due so a
   * freshly connected connection is picked up on the first tick instead of waiting for something to set a
   * cursor it does not have yet.
   */
  async listDueForPoll(limit: number): Promise<CrmConnectionDueRow[]> {
    return db
      .select({
        id: crmConnections.id,
        tenantId: crmConnections.tenantId,
        workspaceId: crmConnections.workspaceId,
        provider: crmConnections.provider,
      })
      .from(crmConnections)
      .where(
        and(
          eq(crmConnections.status, "connected"),
          sql`(${crmConnections.nextPollAt} IS NULL OR ${crmConnections.nextPollAt} <= now())`,
        ),
      )
      .orderBy(asc(crmConnections.nextPollAt))
      .limit(limit);
  },
};
