// apiKeyRepository.ts — create / list / rotate / revoke machine API credentials, and the authentication
// lookup (09 §4 / ADR-0049). Directly modelled on scimTokenRepository, which solved the same problem for an
// org's IdP; read that file first if this one looks surprising.
//
// The `api_keys` table is TENANT-scoped (RLS FORCE USING tenant_id = GUC, rls/apiKeys.sql), so every
// MANAGEMENT operation runs under withTenantTx as leadwolf_app — a security_admin only ever touches their OWN
// org's keys. Create, rotate and revoke are AUDITED in the SAME transaction as the write.
//
// SECURITY: this repository only ever stores or compares the SHA-256 HASH of a key. The plaintext is
// generated in the API layer, shown once, and never persisted — it cannot be recovered from here by anyone,
// including us. `listForTenant` returns a MASKED projection that has no column for the hash at all, so the
// value cannot leak through the list surface even by accident.

import { and, desc, eq, isNull } from "drizzle-orm";
import { withPrivilegedTx, withTenantTx } from "../client.ts";
import { apiKeys } from "../schema/apiKeys.ts";
import { auditRepository } from "./auditRepository.ts";

/** A masked key row for the management surface — never the secret, never its hash. */
export interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** What a presented key resolves to: the key's identity plus the scope every downstream query inherits. */
export interface ApiKeyAuth {
  id: string;
  tenantId: string;
  workspaceId: string;
  scopes: string[];
}

/** The columns the management surface may see. Note the absence of keyHash — that is the point. */
const MASKED = {
  id: apiKeys.id,
  name: apiKeys.name,
  keyPrefix: apiKeys.keyPrefix,
  scopes: apiKeys.scopes,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
};

export const apiKeyRepository = {
  /** The tenant's live keys, newest first — MASKED. RLS-scoped read. Revoked keys are omitted: a revoked
   *  credential is not a thing to manage, and keeping it in the list only invites a confused re-revoke. */
  async listForTenant(tenantId: string): Promise<ApiKeyRow[]> {
    return withTenantTx({ tenantId }, async (tx) => {
      return tx
        .select(MASKED)
        .from(apiKeys)
        .where(and(eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)))
        .orderBy(desc(apiKeys.createdAt));
    });
  },

  /**
   * Persist a new key. The plaintext generation + SHA-256 hashing happen in the API layer; this only stores
   * the supplied hash and prefix. Returns the new row id, which the caller pairs with the one-time plaintext.
   * Audited in the same tx — the metadata records the name, the prefix and the scopes, never the secret.
   */
  async create(input: {
    tenantId: string;
    workspaceId: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    scopes: string[];
    actorUserId: string;
  }): Promise<{ id: string }> {
    const { tenantId, workspaceId, name, keyHash, keyPrefix, scopes, actorUserId } = input;
    return withTenantTx({ tenantId, workspaceId }, async (tx) => {
      const [row] = await tx
        .insert(apiKeys)
        .values({
          tenantId,
          workspaceId,
          name,
          keyHash,
          keyPrefix,
          scopes,
          createdByUserId: actorUserId,
        })
        .returning({ id: apiKeys.id });
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId,
        actorUserId,
        action: "settings.update",
        entityType: "api_key",
        entityId: row!.id,
        metadata: { event: "api_key.create", name, keyPrefix, scopes },
      });
      return { id: row!.id };
    });
  },

  /**
   * Replace a live key's secret IN PLACE — same row, same id, same scopes, new hash and prefix.
   *
   * Rotating in place rather than revoke-and-recreate is what makes the operation useful: the key keeps its
   * identity in the customer's own inventory and in our audit trail, so "rotate the production key" stays one
   * thing across time instead of a graveyard of same-named rows. last_used_at is cleared because it described
   * the OLD secret, and leaving it would make a freshly-rotated key look like it was already in use.
   *
   * Returns false when no LIVE key matched — a revoked or foreign id rotates nothing. RLS scopes the update,
   * and the explicit tenant predicate backs it.
   */
  async rotate(input: {
    tenantId: string;
    id: string;
    keyHash: string;
    keyPrefix: string;
    actorUserId: string;
  }): Promise<boolean> {
    const { tenantId, id, keyHash, keyPrefix, actorUserId } = input;
    return withTenantTx({ tenantId }, async (tx) => {
      const [row] = await tx
        .update(apiKeys)
        .set({ keyHash, keyPrefix, lastUsedAt: null })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      if (!row) return false;
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId: null,
        actorUserId,
        action: "settings.update",
        entityType: "api_key",
        entityId: row.id,
        metadata: { event: "api_key.rotate", keyPrefix },
      });
      return true;
    });
  },

  /**
   * Soft-revoke a key (revoked_at = now). Gated on the key still being live, which keeps the returned flag
   * meaningful and the audit trail truthful — a second revoke reports false rather than logging a second
   * revocation of an already-dead credential. Takes effect on the next call: findActiveByHash stops matching.
   */
  async revoke(tenantId: string, id: string, actorUserId: string): Promise<boolean> {
    return withTenantTx({ tenantId }, async (tx) => {
      const [row] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      if (!row) return false;
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId: null,
        actorUserId,
        action: "settings.update",
        entityType: "api_key",
        entityId: row.id,
        metadata: { event: "api_key.revoke" },
      });
      return true;
    });
  },

  /**
   * Authenticate a presented key by its SHA-256 hash → the key id, its tenant, its workspace and its scopes,
   * or null when the hash matches no LIVE key.
   *
   * This is a PRE-TENANT lookup: the caller's tenant is unknown until the key resolves, so there is no GUC to
   * set and an RLS-scoped read would return nothing. It therefore runs on the PRIVILEGED (BYPASSRLS)
   * connection — which is safe because key_hash is GLOBALLY UNIQUE, so a hash matches at most one row across
   * all tenants, and the tenant is learned FROM the matched row rather than from anything the caller sent.
   * That returned tenantId/workspaceId then scopes EVERY downstream operation via withTenantTx. Exactly the
   * shape of scimTokenRepository.findActiveByHash and userRepository.findByEmail.
   *
   * A revoked key fails the isNull guard and yields null → 401.
   *
   * NOTE: relies on leadwolf_admin having BYPASSRLS. A deployment that grants it without (the Neon caveat in
   * client.ts) makes this fail CLOSED — every API call 401s — which is the safe failure direction.
   */
  async findActiveByHash(keyHash: string): Promise<ApiKeyAuth | null> {
    return withPrivilegedTx(async (tx) => {
      const rows = await tx
        .select({
          id: apiKeys.id,
          tenantId: apiKeys.tenantId,
          workspaceId: apiKeys.workspaceId,
          scopes: apiKeys.scopes,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
        .limit(1);
      return rows[0] ?? null;
    });
  },

  /**
   * Bump last_used_at so the management surface can show last-use and an idle-then-active (possibly stolen)
   * key is detectable. Scoped to the resolved tenant — once findActiveByHash has resolved it we are back
   * inside RLS. Best-effort by contract: a failed bump must never block the call it was observing.
   */
  async touchLastUsed(tenantId: string, id: string): Promise<void> {
    await withTenantTx({ tenantId }, async (tx) => {
      await tx
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId)));
    });
  },
};
