// routes.ts — HTTP wiring for the advanced search surface (24, ADR-0035). Transport only: scope comes from
// the verified token (never the body), validation is Zod at the edge, and all search logic lives behind the
// SearchPort (packages/search). POST is used for contacts/facets (structured query bodies); suggest is GET.

import { checkDatabaseProfileRate } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import {
  countDatabase,
  countDatabaseCompanies,
  databaseCompanyFacets,
  readDatabaseCompanyProfile,
  readDatabasePersonProfile,
  searchCount,
  searchDatabase,
  searchDatabaseCompanies,
} from "@leadwolf/core";
import {
  NotFoundError,
  ValidationError,
  contactQuery,
  databaseCompanyCountResult,
  databaseCompanyFacetsRequest,
  databaseCompanyProfile,
  databaseCompanyQuery,
  databaseCompanySearchPage,
  databaseCountResult,
  databasePersonProfile,
  databaseQuery,
  databaseSearchPage,
  facetCountsRequest,
  suggestQuery,
} from "@leadwolf/types";
import { Hono } from "hono";

import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, requireWorkspace, tenancy } from "../../middleware/tenancy.ts";
import { buildWorkspaceSearchPort } from "./searchPortProvider.ts";
import { searchReadCache } from "./searchReadCache.ts";

export const searchRoutes = new Hono<{ Variables: TenancyVariables }>();

searchRoutes.use("*", authn);
searchRoutes.use("*", tenancy);

/** Filtered, keyset-paged contact search (24 §5/§6). Body = ContactQuery. */
searchRoutes.post("/contacts", async (c) => {
  const workspaceId = requireWorkspace(c, "Select a workspace to search.");

  const parsed = contactQuery.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid search query.");

  const port = await buildWorkspaceSearchPort({ tenantId: c.get("tenantId"), workspaceId });
  const page = await port.searchContacts(parsed.data, {
    workspaceId,
    userId: c.get("claims").sub,
  });
  return c.json(page);
});

/**
 * POST /search/count — the TOTAL matching, workspace-visible contacts for a ContactQuery (24 Phase-3
 * select-all-across-search). Same filters/owner-scoping as /search/contacts; returns { total } (exact, uncapped
 * — only the per-request bulk mutation footprint is capped). Powers the "Select all N results" affordance.
 */
searchRoutes.post("/count", async (c) => {
  const workspaceId = requireWorkspace(c, "Select a workspace to search.");

  const parsed = contactQuery.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid search query.");

  // S5: generation-keyed cache (≤30s eventual per the §4 consistency table) — the capped count scanned to
  // the 10k cap on every "Select all N" render (Phase 2: 3.4s baseline / 0.48s post-S1 on the whale).
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const result = await searchReadCache().count(scope, parsed.data, () =>
    searchCount(scope, parsed.data),
  );
  return c.json(result);
});

/**
 * POST /search/database — the GLOBAL database search (Layer-0-as-database slice 2): every person the
 * PLATFORM holds, not just the workspace's contacts. Workspace scope is still required, but only to flag
 * which hits the caller already owns; the visibility policy (licensed/co-op, unsuppressed, unmerged) is
 * applied inside the repository. The egress parse is load-bearing — it is what guarantees no Layer-0
 * identifier can leak into a response.
 */
searchRoutes.post("/database", async (c) => {
  const workspaceId = requireWorkspace(c, "Select a workspace to search the database.");
  const parsed = databaseQuery.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid database query.");
  const page = await searchDatabase({ tenantId: c.get("tenantId"), workspaceId }, parsed.data);
  return c.json(databaseSearchPage.parse(page));
});

/** POST /search/database/count — the capped total for the same query (the grid header). */
searchRoutes.post("/database/count", async (c) => {
  requireWorkspace(c, "Select a workspace to search the database.");
  const parsed = databaseQuery.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid database query.");
  return c.json(databaseCountResult.parse(await countDatabase(parsed.data)));
});

/**
 * POST /search/database/companies — the GLOBAL company search (search-consolidation stage 2): every company
 * the PLATFORM holds, the firmographic twin of /search/database. Workspace scope is still required, but only
 * to flag which hits the caller already owns; the visibility policy (MASTER_COMPANY_VISIBLE — a real company,
 * with an addressable domain, whose firmographics actually landed) is applied inside the repository.
 *
 * `excludeOwned` moves the "not already in my workspace" filter SERVER-side. It cannot be a join: leadwolf_app
 * is REVOKEd from every master_* table and leadwolf_er cannot see `accounts`, so the two halves are two
 * transactions by construction and the core layer over-fetches candidates and derives the cursor from the last
 * one EXAMINED. A short page with a non-null cursor is correct.
 *
 * The egress parse is load-bearing — it is what guarantees no Layer-0 identifier can leave in a response.
 */
searchRoutes.post("/database/companies", async (c) => {
  if (!env.DATABASE_COMPANY_SEARCH_ENABLED) throw new NotFoundError("Not enabled.");
  const workspaceId = requireWorkspace(c, "Select a workspace to search the database.");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = databaseCompanyQuery.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid company query.");
  const page = await searchDatabaseCompanies(
    { tenantId: c.get("tenantId"), workspaceId },
    parsed.data,
    { excludeOwned: body?.excludeOwned === true },
  );
  return c.json(databaseCompanySearchPage.parse(page));
});

/** POST /search/database/companies/count — the capped total for the same query. */
searchRoutes.post("/database/companies/count", async (c) => {
  if (!env.DATABASE_COMPANY_SEARCH_ENABLED) throw new NotFoundError("Not enabled.");
  requireWorkspace(c, "Select a workspace to search the database.");
  const parsed = databaseCompanyQuery.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid company query.");
  return c.json(databaseCompanyCountResult.parse(await countDatabaseCompanies(parsed.data)));
});

/** POST /search/database/companies/facets — live counts for the low-cardinality company facets. */
searchRoutes.post("/database/companies/facets", async (c) => {
  if (!env.DATABASE_COMPANY_SEARCH_ENABLED) throw new NotFoundError("Not enabled.");
  requireWorkspace(c, "Select a workspace to search the database.");
  const parsed = databaseCompanyFacetsRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid facet request (need query + fields).");
  // `employee_band` is in the facet vocabulary but is DERIVED from employee_count rather than being a
  // column, so it has no GROUP BY of its own — the rail renders its counts from the band chips instead.
  const fields = parsed.data.fields.filter(
    (f): f is "industry" | "hq_country" | "ownership_type" => f !== "employee_band",
  );
  const facets = fields.length === 0 ? [] : await databaseCompanyFacets(parsed.data.query, fields);
  return c.json({ facets });
});

/**
 * GET /search/database/people/:slug — the full masked profile of one Layer-0 person (stage 3).
 *
 * This is NET-NEW read surface, not a relaxed check: there has never been a GET /contacts/:id, and the
 * "add to workspace first" behaviour was a frontend row that had nothing to open. Two invariants hold, both
 * structurally rather than by convention:
 *   • no channel VALUE is in the response (presence bits only) — reveal stays credit-gated and
 *     workspace-scoped, so A-01/A-03 are untouched;
 *   • no workspace-overlay fact is in it either — Layer 0 has no workspace column, so there is nothing
 *     workspace-scoped to leak. The one workspace-derived field is `inWorkspace`, produced under RLS from
 *     the CALLER's own workspace.
 *
 * Absent and not-visible both return 404, byte-identical, so the response shape is not an enumeration
 * oracle. The rate limit is the other half of that guard — a slug is guessable.
 */
searchRoutes.get("/database/people/:slug", async (c) => {
  const workspaceId = requireWorkspace(c, "Select a workspace to view this profile.");
  await checkDatabaseProfileRate(c.get("claims").sub);
  const profile = await readDatabasePersonProfile(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("slug"),
  );
  if (!profile) throw new NotFoundError("Profile not found.");
  return c.json(databasePersonProfile.parse(profile));
});

/** GET /search/database/companies/:domain — the company twin of the route above. Same invariants. */
searchRoutes.get("/database/companies/:domain", async (c) => {
  const workspaceId = requireWorkspace(c, "Select a workspace to view this profile.");
  await checkDatabaseProfileRate(c.get("claims").sub);
  const profile = await readDatabaseCompanyProfile(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("domain"),
  );
  if (!profile) throw new NotFoundError("Profile not found.");
  return c.json(databaseCompanyProfile.parse(profile));
});

/** Typeahead suggestions drawn from indexed values (24 §3). field + prefix as query params. */
searchRoutes.get("/suggest", async (c) => {
  const workspaceId = requireWorkspace(c, "Select a workspace to search.");

  const limitRaw = c.req.query("limit");
  const parsed = suggestQuery.safeParse({
    field: c.req.query("field"),
    prefix: c.req.query("prefix") ?? "",
    limit: limitRaw ? Number(limitRaw) : undefined,
    scope: c.req.query("scope") ?? undefined,
  });
  if (!parsed.success) throw new ValidationError("Invalid suggest request (need field + prefix).");

  const port = await buildWorkspaceSearchPort({ tenantId: c.get("tenantId"), workspaceId });
  const suggestions = await port.suggest(parsed.data, {
    workspaceId,
    userId: c.get("claims").sub,
  });
  return c.json({ suggestions });
});

/** Live facet counts for the current query (24 §5). Body = { query, fields }. */
searchRoutes.post("/facets", async (c) => {
  const workspaceId = requireWorkspace(c, "Select a workspace to search.");

  const parsed = facetCountsRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid facet request (need query + fields).");

  const port = await buildWorkspaceSearchPort({ tenantId: c.get("tenantId"), workspaceId });
  const facets = await port.facetCounts(parsed.data.query, parsed.data.fields, {
    workspaceId,
    userId: c.get("claims").sub,
  });
  return c.json({ facets });
});
