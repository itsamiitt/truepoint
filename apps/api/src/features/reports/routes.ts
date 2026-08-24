// routes.ts — HTTP wiring for the Reports dashboards (C-3.10). GET /summary returns the workspace-scoped
// counts the four rollups are built from.
//
// Transport only: the SQL lives in `reportsRepository` and the presentation (labels, conversion percentages,
// bar maxima) stays client-side in the pure rollups. The response is validated against the contract before it
// leaves the api, so a drift in the shape fails loudly here rather than in the browser.
//
// Why this endpoint exists at all: the dashboards used to roll up in the browser over the most recent 200
// contacts and 200 reveals, so every number above that was wrong while being labelled a total.

import { outcomeMetricsRepository, reportsRepository, withTenantTx } from "@leadwolf/db";
import {
  reportsSummaryQuerySchema,
  reportsSummarySchema,
  revealOutcomesSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { requireWorkspace, tenancy } from "../../middleware/tenancy.ts";

export const reportsRoutes = new Hono<{ Variables: RoleVariables }>();

reportsRoutes.use("*", authn);
reportsRoutes.use("*", tenancy);

const DAY_MS = 86_400_000;

/** Trailing windows, matching the filter row. `all` has no lower bound. */
const RANGE_DAYS: Record<string, number | null> = { "7d": 7, "14d": 14, "30d": 30, all: null };

reportsRoutes.get("/summary", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const workspaceId = requireWorkspace(c, "Select a workspace to continue.");

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

/**
 * GET /reveal-outcomes — hit rate + p95 for the workspace, over the same trailing windows as /summary.
 *
 * This exists because the metric had no reader. `outcomeMetricsRepository` was exported from the db barrel
 * and called by nothing, which meant the number 06-roadmap Phase 1 names its KILL criterion against
 * ("reveal-hit rate <40% in the beachhead after seed load → stop") could not be looked at by anyone.
 *
 * `withTenantTx` directly, rather than a scope-taking repository wrapper: the outcome reads take a `Tx`
 * because they are workspace-scoped BY RLS (rls/usageEvents.sql) rather than by a WHERE clause —
 * `actionCounts` has no workspace predicate in its SQL at all. Running them on any other seam would silently
 * widen them past the caller's workspace, so the transaction is the enforcement and it belongs at the call
 * site. Same shape as account-intelligence's routes.
 *
 * Deliberately NOT exposed here: `outcomeMetricsRepository.mostWanted`. Its own contract says any surface
 * rendering it must first suppression-check every fingerprint against `suppression_list`'s email_blind_index,
 * and that the demand feed is Phase 3. Shipping the numbers without that check would be the compliance
 * failure the method warns about, so the miss COUNT is surfaced and the miss SUBJECTS are not.
 */
reportsRoutes.get(
  "/reveal-outcomes",
  requireRole("owner", "admin", "member", "viewer"),
  async (c) => {
    const workspaceId = requireWorkspace(c, "Select a workspace to continue.");
    const range = c.req.query("range") ?? "30d";
    // Same bounded window set as /summary — an unrecognised value falls back to the 30-day default rather than
    // reaching the interval cast as anything else.
    const days = range in RANGE_DAYS ? RANGE_DAYS[range] : 30;

    const outcomes = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, (tx) =>
      outcomeMetricsRepository.revealOutcomes(tx, days ?? null),
    );

    return c.json(revealOutcomesSchema.parse(outcomes), 200);
  },
);
