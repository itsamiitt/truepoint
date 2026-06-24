// routes.ts — HTTP wiring for static prospect lists (24, bulk "add to list"; mounted at /api/v1/lists).
// Transport only: scope comes from the VERIFIED token (never the body), the caller user id is claims.sub,
// validation is Zod at the edge, and all logic (owner-gating on rename/delete, cross-workspace-safe membership
// writes, affected counts) lives in @leadwolf/core's list transactions. Membership mutations return the
// affected count so the UI can confirm "N added / N removed".

import {
  addContactsToList,
  createDynamicList,
  createList,
  deleteList,
  listListMembers,
  listLists,
  removeContactsFromList,
  updateList,
} from "@leadwolf/core";
import {
  ForbiddenError,
  ValidationError,
  createDynamicListSchema,
  createListSchema,
  listMembersQuerySchema,
  listMembersSchema,
  updateListSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const listsRoutes = new Hono<{ Variables: TenancyVariables }>();

listsRoutes.use("*", authn);
listsRoutes.use("*", tenancy);

function requireWorkspace(c: { get: (k: "workspaceId") => string | undefined }): string {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to use lists.");
  return workspaceId;
}

/** List every list in the active workspace (workspace-shared), with live member counts. */
listsRoutes.get("/", async (c) => {
  const workspaceId = requireWorkspace(c);
  const lists = await listLists({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
  });
  return c.json({ lists });
});

/** Create a list. Body = { name, description? }. */
listsRoutes.post("/", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = createListSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { name, description? }.");
  const created = await createList({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    name: parsed.data.name,
    description: parsed.data.description,
  });
  return c.json(created, 201);
});

/**
 * Create a DYNAMIC list backed by a saved search. Body = { name, savedSearchId, description? }. The
 * savedSearchId is re-validated under the caller's workspace in core (a foreign/absent id 404s — the FK is
 * not a workspace guard); membership then resolves on read from the saved query.
 */
listsRoutes.post("/dynamic", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = createDynamicListSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { name, savedSearchId, description? }.");
  const created = await createDynamicList({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    name: parsed.data.name,
    description: parsed.data.description,
    savedSearchId: parsed.data.savedSearchId,
  });
  return c.json(created, 201);
});

/** Rename / re-describe a list (owner-only — enforced in core). Body = { name?, description? }. */
listsRoutes.patch("/:id", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = updateListSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { name?, description? }.");
  const updated = await updateList({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    id: c.req.param("id"),
    name: parsed.data.name,
    description: parsed.data.description,
  });
  return c.json(updated, 200);
});

/** Delete a list (owner-only — enforced in core; members cascade). */
listsRoutes.delete("/:id", async (c) => {
  const workspaceId = requireWorkspace(c);
  await deleteList({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    id: c.req.param("id"),
  });
  return c.body(null, 204);
});

/**
 * Read a list's members — MASKED (no PII), keyset-paged, newest-added-first. Query = { limit?, cursor? }.
 * 404 if the list isn't in the caller's workspace (no existence leak). The client-supplied list id is never
 * trusted — core re-scopes it under RLS. Returns { members, nextCursor }.
 */
listsRoutes.get("/:id/members", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = listMembersQuerySchema.safeParse({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });
  if (!parsed.success) throw new ValidationError("Query must be { limit?: 1..200, cursor? }.");
  const page = await listListMembers({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    listId: c.req.param("id"),
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
  });
  return c.json(page);
});

/** Add contacts to a list (bulk, idempotent). Body = { contactIds }. Returns { listId, affected }. */
listsRoutes.post("/:id/members", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = listMembersSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { contactIds: string[] }.");
  const result = await addContactsToList({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    listId: c.req.param("id"),
    contactIds: parsed.data.contactIds,
  });
  return c.json(result, 200);
});

/** Remove contacts from a list (bulk). Body = { contactIds }. Returns { listId, affected }. */
listsRoutes.delete("/:id/members", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = listMembersSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { contactIds: string[] }.");
  const result = await removeContactsFromList({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    listId: c.req.param("id"),
    contactIds: parsed.data.contactIds,
  });
  return c.json(result, 200);
});
