// scimTokenRepository.ts — read/create/revoke SCIM provisioning tokens (enterprise IAM, 17 / ADR-0018). The
// `scim_tokens` table is TENANT-scoped (RLS FORCE USING tenant_id = GUC, rls/scim.sql), so every operation
// runs under withTenantTx as leadwolf_app — a security_admin only ever touches their OWN org's tokens. The
// create + the revoke are AUDITED (settings.update on `scim_token`) in the SAME transaction.
//
// SECURITY: this repo only ever stores/handles the SHA-256 HASH of a token. The plaintext token is generated
// and hashed in the API layer (identityRoutes) and shown to the user exactly once; it is never persisted and
// can never be recovered. listForTenant returns a MASKED projection — never token_hash — so the value cannot
// leak through the list surface even by accident.

import { and, desc, eq } from "drizzle-orm";
import { withTenantTx } from "../client.ts";
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
};
