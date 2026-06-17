// routes.ts — HTTP wiring for the advanced search surface (24, ADR-0035). Transport only: scope comes from
// the verified token (never the body), validation is Zod at the edge, and all search logic lives behind the
// SearchPort (packages/search). POST is used for contacts/facets (structured query bodies); suggest is GET.

import {
  ForbiddenError,
  ValidationError,
  contactQuery,
  facetCountsRequest,
  suggestQuery,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";
import { buildWorkspaceSearchPort } from "./searchPortProvider.ts";

export const searchRoutes = new Hono<{ Variables: TenancyVariables }>();

searchRoutes.use("*", authn);
searchRoutes.use("*", tenancy);

/** Filtered, keyset-paged contact search (24 §5/§6). Body = ContactQuery. */
searchRoutes.post("/contacts", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to search.");

  const parsed = contactQuery.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid search query.");

  const port = await buildWorkspaceSearchPort({ tenantId: c.get("tenantId"), workspaceId });
  const page = await port.searchContacts(parsed.data, { workspaceId });
  return c.json(page);
});

/** Typeahead suggestions drawn from indexed values (24 §3). field + prefix as query params. */
searchRoutes.get("/suggest", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to search.");

  const limitRaw = c.req.query("limit");
  const parsed = suggestQuery.safeParse({
    field: c.req.query("field"),
    prefix: c.req.query("prefix") ?? "",
    limit: limitRaw ? Number(limitRaw) : undefined,
    scope: c.req.query("scope") ?? undefined,
  });
  if (!parsed.success) throw new ValidationError("Invalid suggest request (need field + prefix).");

  const port = await buildWorkspaceSearchPort({ tenantId: c.get("tenantId"), workspaceId });
  const suggestions = await port.suggest(parsed.data, { workspaceId });
  return c.json({ suggestions });
});

/** Live facet counts for the current query (24 §5). Body = { query, fields }. */
searchRoutes.post("/facets", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to search.");

  const parsed = facetCountsRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid facet request (need query + fields).");

  const port = await buildWorkspaceSearchPort({ tenantId: c.get("tenantId"), workspaceId });
  const facets = await port.facetCounts(parsed.data.query, parsed.data.fields, { workspaceId });
  return c.json({ facets });
});
