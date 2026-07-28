// crmOauthStateRepository.ts — the short-lived PKCE/state handshake row (crm-sync 00 §4.9 / §5.2).
// WORKSPACE-scoped under FORCE RLS. The analog of the single-use auth code in the auth flow.
//
// This row is a CSRF token, not a record. Three properties make it one, and all three live here rather than
// in the caller so no caller can forget them:
//   - `state` is globally UNIQUE, so a replayed callback cannot mint a second handshake.
//   - `consume` is SINGLE-USE and atomic: it flips consumed_at in the same UPDATE that selects the row, so
//     two concurrent callbacks with the same state cannot both win. A read-then-write here would be a real
//     race, not a theoretical one — a callback URL is a thing users double-click.
//   - Expiry is enforced IN the consume predicate, never by a separate check the caller might skip.
//
// code_verifier_enc is CrmSecretStore ciphertext, never read into a DTO — the only reader is `consume`,
// which hands it straight to the token exchange.

import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";
import { crmOauthStates } from "../schema/crm.ts";

export interface CrmOauthStateInsert {
  tenantId: string;
  workspaceId: string;
  ownerUserId: string;
  provider: string;
  state: string;
  codeVerifierEnc: Uint8Array;
  redirectUri: string;
  environment?: "production" | "sandbox";
  scopes?: string[];
  ttlSeconds?: number;
}

/** What a successful consume yields — everything the exchange needs, and nothing else. */
export interface CrmOauthStateConsumed {
  id: string;
  tenantId: string;
  workspaceId: string;
  ownerUserId: string | null;
  provider: string;
  codeVerifierEnc: Uint8Array | null;
  redirectUri: string | null;
  environment: string;
  scopes: unknown;
}

/** ~10 minutes, matching the AUTH_CODE_TTL posture for the equivalent single-use auth code. */
const DEFAULT_TTL_SECONDS = 600;

export const crmOauthStateRepository = {
  /** Create the handshake row. Run inside withTenantTx — RLS pins it to the caller's workspace. */
  async insert(tx: Tx, row: CrmOauthStateInsert): Promise<string> {
    const ttl = row.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const inserted = await tx
      .insert(crmOauthStates)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        ownerUserId: row.ownerUserId,
        provider: row.provider,
        state: row.state,
        codeVerifierEnc: row.codeVerifierEnc,
        redirectUri: row.redirectUri,
        environment: row.environment ?? "production",
        scopes: row.scopes ?? [],
        expiresAt: sql`now() + (${ttl}::text || ' seconds')::interval`,
      })
      .returning({ id: crmOauthStates.id });
    return inserted[0]!.id;
  },

  /**
   * Atomically consume a state token: returns the row only if it exists, is unconsumed, and has not expired
   * — and marks it consumed in the SAME statement.
   *
   * Runs on the OWNER connection (BYPASSRLS) deliberately, mirroring oauthConnectStateRepository.consume.
   * The OAuth callback arrives before the workspace context is established: the whole point of `state` is
   * that it is what TELLS us which workspace this handshake belongs to, so requiring a workspace GUC to
   * read it would be circular. The row's own tenant/workspace is returned and the caller MUST verify it
   * against the verified session before using it (00 §5.2) — a callback parameter never selects a tenant.
   *
   * Returns null for missing / already-consumed / expired, without distinguishing them: an attacker probing
   * state values learns nothing from the response.
   */
  async consume(state: string): Promise<CrmOauthStateConsumed | null> {
    const rows = await db
      .update(crmOauthStates)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(crmOauthStates.state, state),
          isNull(crmOauthStates.consumedAt),
          sql`${crmOauthStates.expiresAt} > now()`,
        ),
      )
      .returning({
        id: crmOauthStates.id,
        tenantId: crmOauthStates.tenantId,
        workspaceId: crmOauthStates.workspaceId,
        ownerUserId: crmOauthStates.ownerUserId,
        provider: crmOauthStates.provider,
        codeVerifierEnc: crmOauthStates.codeVerifierEnc,
        redirectUri: crmOauthStates.redirectUri,
        environment: crmOauthStates.environment,
        scopes: crmOauthStates.scopes,
      });
    return rows[0] ?? null;
  },

  /**
   * Delete expired handshake rows — the housekeeping sweep. Owner connection (cross-tenant maintenance).
   *
   * Deletes by expiry only, INCLUDING consumed rows: a consumed row has already done its job, and keeping
   * spent PKCE verifiers around is a liability with no upside. Returns the count so the sweep can log it.
   */
  async deleteExpired(olderThan: Date): Promise<number> {
    const deleted = await db
      .delete(crmOauthStates)
      .where(lt(crmOauthStates.expiresAt, olderThan))
      .returning({ id: crmOauthStates.id });
    return deleted.length;
  },
};
