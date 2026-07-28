// routes.ts — the AUTHED CRM surface (crm-sync 00 §5.2 / §9). The session-less inbound webhook is mounted
// separately (webhookRoutes.ts) because this router's `*` authn would 401 a provider's call.
//
// EVERY MUTATION IS owner/admin-GATED. Connecting a CRM grants a third party read/write access to a
// customer's system of record, and flipping a connection to `enforce` is the moment data starts leaving the
// tenant — neither is a member-level action (00 §4.1: privileged mutations are app-gated + audited).
//
// TENANCY COMES FROM THE SESSION, ALWAYS. Every handler reads tenantId/workspaceId off the verified claims;
// no body or query parameter selects a scope. The callback is the interesting case — see its comment.

import { env } from "@leadwolf/config";
import { completeCrmConnect, startCrmConnect } from "@leadwolf/core";
import { CrmConnectError } from "@leadwolf/core";
import {
  crmConnectionRepository,
  crmFieldMappingRepository,
  crmSyncConflictRepository,
  crmSyncRunRepository,
  crmSyncStateRepository,
  withTenantTx,
} from "@leadwolf/db";
import { defaultCrmConnectors } from "@leadwolf/integrations";
import {
  ForbiddenError,
  ValidationError,
  crmConflictResolveSchema,
  crmConnectStartSchema,
  crmMappingUpdateSchema,
  crmSyncModeUpdateSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";
import { enqueueCrmBackfill } from "./crmQueue.ts";

export const crmRoutes = new Hono<{ Variables: TenancyVariables }>();

crmRoutes.use("*", authn);
crmRoutes.use("*", tenancy);

const connectors = defaultCrmConnectors();

/** Least-privilege scope sets (00 §5.2). Pinned in code, never taken from the client. */
const SCOPES: Record<string, string[]> = {
  // Never `full` — object rights come from a least-privilege Permission Set on a dedicated integration user.
  salesforce: ["api", "refresh_token", "offline_access"],
  hubspot: [
    "crm.objects.contacts.read",
    "crm.objects.contacts.write",
    "crm.objects.companies.read",
    "crm.objects.companies.write",
  ],
};

function requireWorkspace(workspaceId: string | undefined): string {
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace first.");
  return workspaceId;
}

// ── Connections ──────────────────────────────────────────────────────────────────────────────────────

crmRoutes.get("/connections", async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const connections = await crmConnectionRepository.listByWorkspace({
    tenantId: c.get("tenantId"),
    workspaceId,
  });
  // The repository's safeColumns omits oauth_token_enc, so no credential can reach this response even if a
  // future field is added to the DTO carelessly.
  return c.json({ connections });
});

/**
 * Begin the OAuth connect: mint the PKCE + state handshake and return the provider's consent URL.
 *
 * No credential crosses the wire — the consent screen mints it, and the callback exchanges it server-side.
 * The scope set is pinned in code above rather than accepted from the body: a client that could choose its
 * own scopes could request `full`.
 */
crmRoutes.post("/connections", requireRole("owner", "admin"), async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const parsed = crmConnectStartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ValidationError("Body must be { provider: 'salesforce'|'hubspot', environment? }.");
  }
  const connector = connectors[parsed.data.provider as keyof typeof connectors];
  if (!connector?.configured) {
    throw new ValidationError(`The ${parsed.data.provider} connector is not configured.`);
  }
  const redirectUri = env.CRM_OAUTH_REDIRECT_URI;
  if (!redirectUri) throw new ValidationError("CRM_OAUTH_REDIRECT_URI is not configured.");

  const { authorizeUrl } = await startCrmConnect({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    userId: c.get("claims").sub,
    provider: parsed.data.provider,
    connector,
    redirectUri,
    scopes: SCOPES[parsed.data.provider] ?? [],
    environment: parsed.data.environment ?? "production",
  });
  // The state is deliberately NOT returned: it is a CSRF token that belongs in the provider's URL, and
  // handing it to the client would let a page script complete a handshake it did not start.
  return c.json({ authorize_url: authorizeUrl }, 201);
});

/**
 * Complete the OAuth connect.
 *
 * AUTHED, not session-less: the user returns to app.truepoint.in carrying their own session, and
 * completeCrmConnect compares the handshake's tenant/workspace against that VERIFIED session. A callback
 * query parameter must never be able to select a tenant — that comparison is the whole reason this route
 * sits inside the authed router rather than beside the webhook.
 */
crmRoutes.get("/oauth/callback", requireRole("owner", "admin"), async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const code = c.req.query("code");
  const state = c.req.query("state");
  const provider = c.req.query("provider") ?? "salesforce";
  if (!code || !state) throw new ValidationError("Missing `code` or `state`.");

  const connector = connectors[provider as keyof typeof connectors];
  if (!connector) throw new ValidationError(`Unknown provider ${provider}.`);

  try {
    const result = await completeCrmConnect({
      sessionScope: { tenantId: c.get("tenantId"), workspaceId },
      userId: c.get("claims").sub,
      state,
      code,
      connector,
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof CrmConnectError) {
      // The reason is a stable code and carries no secret — safe to return, and useful to the operator.
      // Deliberately a 400 for every reason: distinguishing "wrong workspace" from "expired state" would
      // tell a prober which of their guesses was closer.
      throw new ValidationError(`CRM connect refused: ${err.reason}`);
    }
    throw err;
  }
});

/**
 * Flip the dark-launch gate. Its own endpoint, owner/admin-gated, because promoting to `enforce` is the
 * moment TruePoint data starts being written into the customer's CRM — not a field folded into a general
 * update (00 §4.1).
 */
crmRoutes.patch("/connections/:id/sync-mode", requireRole("owner", "admin"), async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const parsed = crmSyncModeUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ValidationError("Body must be { sync_mode: 'disabled'|'shadow'|'enforce' }.");
  }
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const connectionId = c.req.param("id");

  const updated = await withTenantTx(scope, async (tx) => {
    // The id comes from the client, so its existence IN THIS WORKSPACE is verified before use — RLS would
    // make the update affect zero rows anyway, but a silent no-op is a worse answer than a 404.
    const existing = await crmConnectionRepository.getById(tx, connectionId);
    if (!existing) return null;
    await crmConnectionRepository.setSyncMode(tx, connectionId, parsed.data.sync_mode);
    return { id: connectionId, syncMode: parsed.data.sync_mode };
  });
  if (!updated) throw new ValidationError("No such connection in this workspace.");
  return c.json(updated);
});

/** Trigger the initial backfill for a connection. Low-priority queue; idempotent per (connection, object). */
crmRoutes.post("/connections/:id/backfill", requireRole("owner", "admin"), async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const connectionId = c.req.param("id");

  const connection = await withTenantTx(scope, (tx) =>
    crmConnectionRepository.getById(tx, connectionId),
  );
  if (!connection) throw new ValidationError("No such connection in this workspace.");

  await enqueueCrmBackfill({
    kind: "drive",
    scope,
    connectionId,
    provider: connection.provider as "salesforce" | "hubspot",
    objectType: "contact",
  });
  return c.json({ queued: true }, 202);
});

// ── Health + review reads (00 §9) ────────────────────────────────────────────────────────────────────

crmRoutes.get("/connections/:id/runs", async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const runs = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, (tx) =>
    crmSyncRunRepository.listRecentForConnection(tx, c.req.param("id"), 50),
  );
  return c.json({ runs });
});

crmRoutes.get("/connections/:id/streams", async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const streams = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, (tx) =>
    crmSyncStateRepository.listByConnection(tx, c.req.param("id")),
  );
  return c.json({ streams });
});

crmRoutes.get("/connections/:id/mappings", async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const mappings = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, (tx) =>
    crmFieldMappingRepository.listByConnection(tx, c.req.param("id")),
  );
  return c.json({ mappings });
});

/**
 * Edit one field mapping's policy. owner/admin only: a mapping decides which of a customer's fields TruePoint
 * may overwrite in their CRM, and flipping one to outbound/truepoint starts writing a field that was
 * previously read-only.
 */
crmRoutes.patch("/mappings/:id", requireRole("owner", "admin"), async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const parsed = crmMappingUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ValidationError("Body must set at least one of direction, authority or enabled.");
  }
  const ok = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, (tx) =>
    crmFieldMappingRepository.updatePolicy(tx, c.req.param("id"), parsed.data),
  );
  // RLS filters a foreign mapping out of the UPDATE entirely, so false covers both "not yours" and "no such
  // row" — deliberately indistinguishable, so an id prober learns nothing from the response.
  if (!ok) throw new ValidationError("No such mapping in this workspace.");
  return c.json({ id: c.req.param("id"), ...parsed.data });
});

/** The conflict review queue. Values are already PII-masked by the repository's write path (§4.7). */
crmRoutes.get("/conflicts", async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const conflicts = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, (tx) =>
    crmSyncConflictRepository.listOpen(tx, 100),
  );
  return c.json({ conflicts });
});

/** Close a conflict. Records who decided; only an `open` row transitions, so a stale UI cannot re-decide. */
crmRoutes.patch("/conflicts/:id", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const parsed = crmConflictResolveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { status: 'resolved'|'ignored' }.");

  const ok = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, (tx) =>
    crmSyncConflictRepository.resolve(
      tx,
      c.req.param("id"),
      parsed.data.status,
      c.get("claims").sub,
    ),
  );
  if (!ok) throw new ValidationError("No such open conflict in this workspace.");
  return c.json({ id: c.req.param("id"), status: parsed.data.status });
});
