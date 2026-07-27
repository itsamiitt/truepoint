// routes.ts — HTTP wiring for the Reports dashboards (C-3.10). GET /summary returns the workspace-scoped
// counts the four rollups are built from.
//
// Transport only: the SQL lives in `reportsRepository` and the presentation (labels, conversion percentages,
// bar maxima) stays client-side in the pure rollups. The response is validated against the contract before it
// leaves the api, so a drift in the shape fails loudly here rather than in the browser.
//
// Why this endpoint exists at all: the dashboards used to roll up in the browser over the most recent 200
// contacts and 200 reveals, so every number above that was wrong while being labelled a total.

import { reportsRepository } from "@leadwolf/db";
import { ForbiddenError, reportsSummaryQuerySchema, reportsSummarySchema } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const reportsRoutes = new Hono<{ Variables: RoleVariables }>();

reportsRoutes.use("*", authn);
reportsRoutes.use("*", tenancy);

const DAY_MS = 86_400_000;

/** Trailing windows, matching the filter row. `all` has no lower bound. */
const RANGE_DAYS: Record<string, number | null> = { "7d": 7, "14d": 14, "30d": 30, all: null };

reportsRoutes.get("/summary", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");

  // Parsed, not read: `tz` reaches date_trunc's third argument, so it is bounded and pattern-checked at the
  // contract rather than trusted from the query string.
  const query = reportsSummaryQuerySchema.parse({
    range: c.req.query("range") ?? undefined,
    member: c.req.query("member") ?? undefined,
    tz: c.req.query("tz") ?? undefined,
  });

  const days = RANGE_DAYS[query.range] ?? null;
  const rows = await reportsRepository.summary(
    { tenantId: c.get("tenantId"), workspaceId },
    {
      since: days === null ? null : new Date(Date.now() - days * DAY_MS),
      // "all" is the sentinel for no member filter; anything else is used as an id and is only ever
      // compared against owner/revealer columns under RLS, never interpolated.
      memberId: query.member === "all" ? null : query.member,
      tz: query.tz,
    },
  );

  return c.json(reportsSummarySchema.parse(rows), 200);
});
