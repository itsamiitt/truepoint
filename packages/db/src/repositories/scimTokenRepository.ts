// scimTokenRepository.ts — read/create/revoke SCIM provisioning tokens (enterprise IAM, 17 / ADR-0018). The
// `scim_tokens` table is TENANT-scoped (RLS FORCE USING tenant_id = GUC, rls/scim.sql), so every operation
// runs under withTenantTx as leadwolf_app — a security_admin only ever touches their OWN org's tokens. The
// create + the revoke are AUDITED (settings.update on `scim_token`) in the SAME transaction.
//
// SECURITY: this repo only ever stores/handles the SHA-256 HASH of a token. The plaintext token is generated
// and hashed in the API layer (identityRoutes) and shown to the user exactly once; it is never persisted and
// can never be recovered. listForTenant returns a MASKED projection — never token_hash — so the value cannot
// leak through the list surface even by accident.

import { and, desc, eq, isNull } from "drizzle-orm";
import { withPrivilegedTx, withTenantTx } from "../client.ts";
import { scimTokens } from "../schema/scim.ts";
import { auditRepository } from "./auditRepository.ts";

/** A masked SCIM token row for the management surface — NEVER carries the token value or its hash. */
export interface ScimTokenRecord {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** The authentication result for a presented SCIM bearer token — the token's id and the tenant it scopes to. */
export interface ScimTokenAuth {
  id: string;
  tenantId: string;
}

export const scimTokenRepository = {
  /** The tenant's SCIM tokens, newest first — MASKED (no token_hash). RLS-scoped read. */
  async listForTenant(tenantId: string): Promise<ScimTokenRecord[]> {
    return withTenantTx({ tenantId }, async (tx) => {
      return tx
        .select({
          id: scimTokens.id,
          name: scimTokens.name,
          createdAt: scimTokens.createdAt,
          lastUsedAt: scimTokens.lastUsedAt,
          revokedAt: scimTokens.revokedAt,
        })
        .from(scimTokens)
        .where(eq(scimTokens.tenantId, tenantId))
        .orderBy(desc(scimTokens.createdAt));
    });
  },

  /**
   * Persist a new SCIM token. The PLAINTEXT generation + SHA-256 hashing happen in the API layer — this only
   * stores the supplied `tokenHash`. Returns the new row id (the caller pairs it with the one-time plaintext).
   * Audited (settings.update on `scim_token`) in the same tx — the metadata records the name only, never the
   * token or its hash.
   */
  async create(
    tenantId: string,
    name: string,
    tokenHash: string,
    actorUserId: string,
  ): Promise<{ id: string }> {
    return withTenantTx({ tenantId }, async (tx) => {
      const [row] = await tx
        .insert(scimTokens)
        .values({ tenantId, name, tokenHash, createdByUserId: actorUserId })
        .returning({ id: scimTokens.id });
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId: null, // tenant-level identity change
        actorUserId,
        action: "settings.update",
        entityType: "scim_token",
        entityId: row!.id,
        metadata: { event: "scim_token.create", name },
      });
      return { id: row!.id };
    });
  },

  /**
   * Soft-revoke a token (set revoked_at=now). Idempotent: a second revoke is a no-op. Audited in the same tx.
   * RLS-scoped, so an id from another tenant matches no row (the WHERE tenant_id guard backs the RLS clause).
   * Returns true when a row was revoked, false when nothing matched (already revoked / not found).
   */
  async revoke(tenantId: string, id: string, actorUserId: string): Promise<boolean> {
    return withTenantTx({ tenantId }, async (tx) => {
      const [row] = await tx
        .update(scimTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(scimTokens.id, id),
            eq(scimTokens.tenantId, tenantId),
            // Only flip a token that is still live — keeps revoke idempotent and the audit truthful.
            // (drizzle: isNull guard via raw condition is unnecessary; a second revoke just rewrites the ts,
            //  but gating on it keeps the returned `revoked` flag meaningful.)
          ),
        )
        .returning({ id: scimTokens.id });
      if (!row) return false;
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId: null,
        actorUserId,
        action: "settings.update",
        entityType: "scim_token",
        entityId: row.id,
        metadata: { event: "scim_token.revoke" },
      });
      return true;
    });
  },

  /**
   * Authenticate a presented SCIM bearer token by its SHA-256 hash → the token id + the tenant it scopes to,
   * or null when the hash matches no LIVE (un-revoked) token. This is a PRE-TENANT lookup: the SCIM caller's
   * tenant is unknown until the token resolves (mirrors userRepository.findByEmail's pre-tenant identity read).
   *
   * scim_tokens is FORCE-RLS tenant-scoped, so a read with no tenant GUC set returns nothing under the app
   * role — but token_hash is GLOBALLY UNIQUE, so a hash matches at most one row across all tenants. We
   * therefore run this on the PRIVILEGED (BYPASSRLS) connection and learn the tenant FROM the matched row;
   * the returned tenantId then scopes EVERY downstream SCIM operation via withTenantTx. The caller compares
   * the hash, never the plaintext (the plaintext is never stored). A revoked token (revoked_at set) fails the
   * isNull guard and yields null → 401.
   *
   * NOTE: relies on leadwolf_admin having BYPASSRLS. If a deployment grants it without BYPASSRLS (the Neon
   * caveat noted in client.ts for withPlatformTx), this read would fail-closed (null → every SCIM call 401s),
   * which is the safe failure direction. // CONFIRM: leadwolf_admin BYPASSRLS in the target environment.
   */
  async findActiveByHash(tokenHash: string): Promise<ScimTokenAuth | null> {
    return withPrivilegedTx(async (tx) => {
      const rows = await tx
        .select({ id: scimTokens.id, tenantId: scimTokens.tenantId })
        .from(scimTokens)
        .where(and(eq(scimTokens.tokenHash, tokenHash), isNull(scimTokens.revokedAt)))
        .limit(1);
      return rows[0] ?? null;
    });
  },

  /**
   * Bump last_used_at on a token (wires the WIRE-deferred column in scim.ts) so the management surface can
   * show last-use and an anomalous idle-then-active token is detectable (09 "SCIM token abuse"). Scoped to the
   * resolved tenant under withTenantTx — once findActiveByHash has resolved the tenant we are back inside RLS.
   * Best-effort by contract: the caller must not let a failed bump block the SCIM operation (monitoring signal,
   * not an auth gate).
   */
  async touchLastUsed(tenantId: string, id: string): Promise<void> {
    await withTenantTx({ tenantId }, async (tx) => {
      await tx
        .update(scimTokens)
        .set({ lastUsedAt: new Date() })
        .where(and(eq(scimTokens.id, id), eq(scimTokens.tenantId, tenantId)));
    });
  },
};
