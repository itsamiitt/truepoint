// oauthConnectStateRepository.ts — the short-lived CSRF + PKCE handshake store for the mailbox OAuth redirect
// (M12 P1). `create` runs SCOPED (leadwolf_app) inside the caller's withTenantTx during the START. `consume`
// runs on the OWNER connection because the OAuth callback is SESSION-LESS (no tenant GUC) and must resolve the
// row by its secret `state_token`; oauth_connect_state is RLS ENABLE-not-FORCE (rls/email.sql) so the owner
// reads it (the platform_audit_log pattern). The consume is a single atomic `UPDATE ... RETURNING` so a state
// token is usable AT MOST ONCE (CSRF + replay guard) — a second callback with the same token gets null.

import { sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";
import { oauthConnectState } from "../schema/email.ts";

export interface ConnectStateInsert {
  tenantId: string;
  workspaceId: string;
  userId: string;
  provider: string;
  stateToken: string;
  pkceVerifierEnc: Uint8Array;
  redirectAfter?: string | null;
  expiresAt: Date;
}

export interface ConnectStateRecord {
  tenantId: string;
  workspaceId: string;
  userId: string;
  provider: string;
  pkceVerifierEnc: Uint8Array;
  redirectAfter: string | null;
}

export const oauthConnectStateRepository = {
  /** Persist a pending handshake (scoped INSERT — RLS WITH CHECK binds it to the caller's tenant). */
  async create(tx: Tx, row: ConnectStateInsert): Promise<void> {
    await tx.insert(oauthConnectState).values({
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      userId: row.userId,
      provider: row.provider,
      stateToken: row.stateToken,
      pkceVerifierEnc: row.pkceVerifierEnc,
      redirectAfter: row.redirectAfter ?? null,
      expiresAt: row.expiresAt,
    });
  },

  /**
   * Atomically CONSUME a handshake by its secret state_token (the session-less callback path). Owner
   * connection (RLS-exempt; ENABLE-not-FORCE). Returns null when the token is unknown, already consumed, or
   * expired — single-use, so a replayed/forged callback can never re-drive the exchange.
   */
  async consume(stateToken: string): Promise<ConnectStateRecord | null> {
    const rows = await db
      .update(oauthConnectState)
      .set({ consumedAt: sql`now()` })
      .where(
        sql`${oauthConnectState.stateToken} = ${stateToken}
            AND ${oauthConnectState.consumedAt} IS NULL
            AND ${oauthConnectState.expiresAt} > now()`,
      )
      .returning({
        tenantId: oauthConnectState.tenantId,
        workspaceId: oauthConnectState.workspaceId,
        userId: oauthConnectState.userId,
        provider: oauthConnectState.provider,
        pkceVerifierEnc: oauthConnectState.pkceVerifierEnc,
        redirectAfter: oauthConnectState.redirectAfter,
      });
    return rows[0] ?? null;
  },

  /** TTL sweep — drop consumed/expired handshakes. Owner connection; called by a periodic maintenance job. */
  async sweepExpired(): Promise<number> {
    const rows = await db
      .delete(oauthConnectState)
      .where(
        sql`${oauthConnectState.expiresAt} < now() OR ${oauthConnectState.consumedAt} IS NOT NULL`,
      )
      .returning({ id: oauthConnectState.id });
    return rows.length;
  },
};
