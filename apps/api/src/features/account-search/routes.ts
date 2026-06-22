// routes.ts — HTTP wiring for the COMPANY-level (accounts) search surface (24/ADR-0035), the firmographic
// sibling of features/search. Transport only: scope comes from the VERIFIED token (never the body), validation
// is Zod at the edge, and all search logic lives behind the @leadwolf/db accountSearchRepository (workspace
// isolation is RLS via withTenantTx in the repo). POST is used for search/facets/count (structured bodies);
// suggest is GET. Accounts carry no PII, so there is no reveal/mask seam here — just firmographic reads.

import { searchAccountsCount } from "@leadwolf/core";
import { accountSearchRepository } from "@leadwolf/db";
import {
  ForbiddenError,
  ValidationError,
  accountFacetCountsRequest,
  accountQuery,
  accountSuggestQuery,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const accountSearchRoutes = new Hono<{ Variables: TenancyVariables }>();

accountSearchRoutes.use("*", authn);
accountSearchRoutes.use("*", tenancy);

/** Filtered, keyset-paged company search (24 §5/§6). Body = AccountQuery → { accounts, nextCursor }. */
accountSearchRoutes.post("/search", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to search.");

  const parsed = accountQuery.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid account search query.");

  const page = await accountSearchRepository.searchAccounts(
    { tenantId: c.get("tenantId"), workspaceId },
    parsed.data,
  );
  return c.json(page);
});

/** Live facet counts for the current query (24 §5). Body = { query, fields } → { facets }. */
accountSearchRoutes.post("/facets", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to search.");

  const parsed = accountFacetCountsRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid facet request (need query + fields).");

  const facets = await accountSearchRepository.facetCounts(
    { tenantId: c.get("tenantId"), workspaceId },
    parsed.data.query,
    parsed.data.fields,
  );
  return c.json({ facets });
});

/** The TOTAL matching, workspace-visible accounts for an AccountQuery (24 Phase-3 select-all). Returns { total }. */
accountSearchRoutes.post("/count", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to search.");

  const parsed = accountQuery.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid account search query.");

  const result = await searchAccountsCount(
    { tenantId: c.get("tenantId"), workspaceId },
    parsed.data,
  );
  return c.json(result);
});

/** Typeahead suggestions drawn from indexed account values (24 §3). field + prefix as query params. */
accountSearchRoutes.get("/suggest", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to search.");

  const limitRaw = c.req.query("limit");
  const parsed = accountSuggestQuery.safeParse({
    field: c.req.query("field"),
    prefix: c.req.query("prefix") ?? "",
    limit: limitRaw ? Number(limitRaw) : undefined,
  });
  if (!parsed.success) throw new ValidationError("Invalid suggest request (need field + prefix).");

  const suggestions = await accountSearchRepository.suggest(
    { tenantId: c.get("tenantId"), workspaceId },
    parsed.data,
  );
  return c.json({ suggestions });
});
