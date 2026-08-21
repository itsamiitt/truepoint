// routes.ts — machine API credential management (09 §4; ADR-0049). Mounted at
// /api/v1/tenants/me/api-keys, which is the path apps/web/src/features/settings-developer has been calling
// since M10 and getting a 404 from. The request and response shapes are transcribed from that client rather
// than designed here — see packages/types/src/apiKeys.ts.
//
// AUTHORIZATION: authn → tenancy → requireOrgRole("security_admin"). Key management is a TENANT-level duty on
// the org-role axis (ADR-0030: security_admin owns API keys, SSO config and auth policy), not a workspace
// role — a workspace `admin` is not automatically allowed to mint a credential that can spend the tenant's
// credits. `owner` passes implicitly, as it does on every org-role guard.
//
// SECRET HANDLING: the plaintext is generated here, returned exactly once in the create/rotate response, and
// never stored, logged or recoverable. Only its SHA-256 hash reaches the database. There is deliberately no
// endpoint that reads a secret back — a vendor who can show you your own key can also show it to whoever
// compromises them.

import { apiKeyRepository } from "@leadwolf/db";
import {
  type ApiKeyRecord,
  type ApiKeyScope,
  NotFoundError,
  ValidationError,
  createApiKeyRequestSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type OrgRoleVariables, requireOrgRole } from "../../middleware/requireOrgRole.ts";
import { requireWorkspace, tenancy } from "../../middleware/tenancy.ts";
import { mintKey } from "../../lib/apiKeySecret.ts";

export const apiKeyRoutes = new Hono<{ Variables: OrgRoleVariables }>();

apiKeyRoutes.use("*", authn);
apiKeyRoutes.use("*", tenancy);
apiKeyRoutes.use("*", requireOrgRole("security_admin"));

/** Row → wire. ISO strings and `prefix` (not keyPrefix), because that is what the shipped client reads. */
function toRecord(row: {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.keyPrefix,
    scopes: row.scopes as ApiKeyScope[],
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

apiKeyRoutes.get("/", async (c) => {
  const rows = await apiKeyRepository.listForTenant(c.get("tenantId"));
  return c.json({ keys: rows.map(toRecord) });
});

apiKeyRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createApiKeyRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      "Body must be { name: string, scopes: ApiKeyScope[] } with ≥1 scope.",
    );
  }
  // The workspace the key will act in comes from the caller's ACTIVE session workspace, never the body —
  // otherwise a security_admin could mint a credential scoped to a workspace they cannot themselves reach.
  const workspaceId = requireWorkspace(c, "Select a workspace before creating an API key.");
  const { secret, keyHash, keyPrefix } = mintKey();

  const { id } = await apiKeyRepository.create({
    tenantId: c.get("tenantId"),
    workspaceId,
    name: parsed.data.name,
    keyHash,
    keyPrefix,
    scopes: parsed.data.scopes,
    actorUserId: c.get("claims").sub,
  });

  // 201 with the one-time secret. This is the only response in the system that carries it.
  return c.json({ id, secret }, 201);
});

apiKeyRoutes.post("/:id/rotate", async (c) => {
  const id = c.req.param("id");
  const { secret, keyHash, keyPrefix } = mintKey();
  const rotated = await apiKeyRepository.rotate({
    tenantId: c.get("tenantId"),
    id,
    keyHash,
    keyPrefix,
    actorUserId: c.get("claims").sub,
  });
  // Indistinguishable from "not yours" on purpose — a revoked, missing or foreign id all answer the same, so
  // ids cannot be enumerated through this route.
  if (!rotated) throw new NotFoundError("API key not found.");
  return c.json({ id, secret });
});

apiKeyRoutes.delete("/:id", async (c) => {
  const revoked = await apiKeyRepository.revoke(
    c.get("tenantId"),
    c.req.param("id"),
    c.get("claims").sub,
  );
  if (!revoked) throw new NotFoundError("API key not found.");
  return c.json({ ok: true });
});
