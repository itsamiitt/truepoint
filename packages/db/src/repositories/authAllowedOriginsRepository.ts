// authAllowedOriginsRepository.ts — read/write the managed callback-origin allow-list (auth_allowed_origins,
// AUTH-036, doc 11 §2). READS (getScopeOrigins) return the platform-NULL + own-tenant rows RLS admits under
// withTenantTx; @leadwolf/config resolveAllowedOrigins then unions them with the env floor. WRITES are
// org-scoped (a tenant's security_admin adds/removes its OWN origins) and audited in-tx; the WITH-CHECK RLS
// blocks a cross-tenant write. PLATFORM origins are owner-only (withPlatformTx) and deliberately not reachable
// here. Origins are stored ALREADY-canonicalised — the app layer runs canonicalManagedOrigin(input) (which
// rejects non-https / path / wildcard / creds) BEFORE calling addTenantOrigin, so a stored entry can never be
// an open-redirect target. Isolation proven by test/authAllowedOriginsIsolation.itest.ts.

import { and, eq } from "drizzle-orm";
import { withTenantTx } from "../client.ts";
import { authAllowedOrigins } from "../schema/auth.ts";
import { auditRepository } from "./auditRepository.ts";

export interface AllowedOriginRow {
  scope: string;
  origin: string;
  kind: string;
}

export const authAllowedOriginsRepository = {
  /** Every origin visible to this tenant under RLS: the platform (NULL) origins + its own — the input to
   *  resolveAllowedOrigins (which then unions the env floor). */
  async getScopeOrigins(scope: { tenantId: string }): Promise<AllowedOriginRow[]> {
    return withTenantTx(scope, async (tx) =>
      tx
        .select({
          scope: authAllowedOrigins.scope,
          origin: authAllowedOrigins.origin,
          kind: authAllowedOrigins.kind,
        })
        .from(authAllowedOrigins),
    );
  },

  /** Add an org-scoped origin (idempotent — onConflictDoNothing on the unique (scope, tenant_id, origin)) and
   *  audit it. `origin` MUST already be canonical (canonicalManagedOrigin at the app layer). */
  async addTenantOrigin(args: {
    tenantId: string;
    origin: string;
    kind?: string;
    actorUserId: string;
  }): Promise<void> {
    const { tenantId, origin, kind = "callback", actorUserId } = args;
    await withTenantTx({ tenantId }, async (tx) => {
      await tx
        .insert(authAllowedOrigins)
        .values({ scope: "org", tenantId, origin, kind, createdBy: actorUserId })
        .onConflictDoNothing();
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId: null,
        actorUserId,
        action: "settings.update",
        entityType: "auth_allowed_origin",
        entityId: tenantId,
        metadata: { op: "add", origin, kind },
      });
    });
  },

  /** Remove an org-scoped origin (no-op if absent) and audit it. Scoped to the tenant's OWN org rows — the RLS
   *  + the explicit WHERE both bar removing a platform or another tenant's origin. */
  async removeTenantOrigin(args: {
    tenantId: string;
    origin: string;
    actorUserId: string;
  }): Promise<void> {
    const { tenantId, origin, actorUserId } = args;
    await withTenantTx({ tenantId }, async (tx) => {
      await tx
        .delete(authAllowedOrigins)
        .where(
          and(
            eq(authAllowedOrigins.scope, "org"),
            eq(authAllowedOrigins.tenantId, tenantId),
            eq(authAllowedOrigins.origin, origin),
          ),
        );
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId: null,
        actorUserId,
        action: "settings.update",
        entityType: "auth_allowed_origin",
        entityId: tenantId,
        metadata: { op: "remove", origin },
      });
    });
  },
};
