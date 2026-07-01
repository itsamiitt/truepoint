// routes.ts — the in-app notification feed (G-NTF-1). Authenticated + workspace-scoped; every read/write is
// bounded to the CALLER'S OWN notifications (userId = claims.sub) within their active workspace (RLS bounds the
// workspace; the repo's user_id predicate bounds the user). No workspace selected → an empty feed (graceful,
// not an error). Transport only; the keyset + counting live in @leadwolf/db notificationRepository.

import { notificationRepository, withTenantTx } from "@leadwolf/db";
import { ValidationError } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const notificationsRoutes = new Hono<{ Variables: TenancyVariables }>();
notificationsRoutes.use("*", authn);
notificationsRoutes.use("*", tenancy);

const readRole = requireRole("owner", "admin", "member", "viewer");

// The feed: a keyset page of the caller's notifications + the live unread count, in ONE workspace-scoped tx.
notificationsRoutes.get("/", readRole, async (c) => {
  const workspaceId = c.get("workspaceId");
  const userId = c.get("claims").sub;
  if (!workspaceId) return c.json({ notifications: [], nextCursor: null, unreadCount: 0 });
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 50);
  const cursor = c.req.query("cursor") || undefined;
  const page = await withTenantTx(scope, async (tx) => {
    const list = await notificationRepository.listForUser(scope, userId, { limit, cursor }, tx);
    const unreadCount = await notificationRepository.unreadCount(scope, userId, tx);
    return { list, unreadCount };
  });
  return c.json({
    notifications: page.list.rows,
    nextCursor: page.list.nextCursor,
    unreadCount: page.unreadCount,
  });
});

// Lightweight unread count for the bell badge (polled).
notificationsRoutes.get("/unread-count", readRole, async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) return c.json({ unreadCount: 0 });
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const unreadCount = await notificationRepository.unreadCount(scope, c.get("claims").sub);
  return c.json({ unreadCount });
});

// Mark ALL the caller's unread notifications read (one literal segment — registered before the :id route).
notificationsRoutes.post("/read-all", readRole, async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) return c.json({ ok: true, marked: 0 });
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const marked = await notificationRepository.markAllRead(scope, c.get("claims").sub);
  return c.json({ ok: true, marked });
});

// Mark ONE notification read (the caller's own; a foreign/unknown id simply updates nothing → read:false).
notificationsRoutes.post("/:id/read", readRole, async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ValidationError("Select a workspace to manage notifications.");
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const read = await notificationRepository.markRead(scope, c.get("claims").sub, id);
  return c.json({ ok: true, read });
});
