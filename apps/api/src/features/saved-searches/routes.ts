// routes.ts — HTTP wiring for saved searches / segments (M8, 24 §8; mounted at /api/v1/saved-searches).
// Transport only: scope comes from the VERIFIED token (never the body), the caller user id is claims.sub,
// validation is Zod at the edge, and all logic (filter validation on save, owner-gating, visibility) lives
// in @leadwolf/core's saved-search transactions. Applying a saved search is the client re-running
// POST /api/v1/search/contacts with the returned `filters` blob — there is no "apply" endpoint here.

import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  updateSavedSearch,
} from "@leadwolf/core";
import {
  ForbiddenError,
  ValidationError,
  createSavedSearchSchema,
  updateSavedSearchSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const savedSearchesRoutes = new Hono<{ Variables: TenancyVariables }>();

savedSearchesRoutes.use("*", authn);
savedSearchesRoutes.use("*", tenancy);

/** List the saved searches visible to the caller in the active workspace (own private + all workspace). */
savedSearchesRoutes.get("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view saved searches.");
  const searches = await listSavedSearches({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
  });
  return c.json({ searches });
});

/** Save the current filter set. Body = { name, filters (a ContactQuery), visibility? }. */
savedSearchesRoutes.post("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before saving a search.");
  const parsed = createSavedSearchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { name, filters, visibility? }.");
  const saved = await createSavedSearch({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    name: parsed.data.name,
    filters: parsed.data.filters,
    visibility: parsed.data.visibility,
  });
  return c.json(saved, 201);
});

/** Rename / re-scope a saved search (owner-only — enforced in core). Body = { name?, visibility? }. */
savedSearchesRoutes.patch("/:id", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before editing a saved search.");
  const parsed = updateSavedSearchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { name?, visibility? }.");
  const updated = await updateSavedSearch({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    id: c.req.param("id"),
    name: parsed.data.name,
    visibility: parsed.data.visibility,
  });
  return c.json(updated, 200);
});

/** Delete a saved search (owner-only — enforced in core). */
savedSearchesRoutes.delete("/:id", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before deleting a saved search.");
  await deleteSavedSearch({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    id: c.req.param("id"),
  });
  return c.body(null, 204);
});
