// usageRoutes.ts — the customer's own API usage, for the dashboard panel (ADR-0049).
//
// A SEPARATE router from the key-management one, and the reason is authorization rather than tidiness.
// Managing credentials is a `security_admin` duty (ADR-0030); READING how much the workspace spent is not —
// it is ordinary spend visibility, and gating it behind the same role would 403 almost everyone who opens the
// dashboard. So this carries `requireRole(..., "viewer")`, the same posture the billing reads use.
//
// The response is bounded by construction. api_key_usage_daily is a rollup, so a 30-day window returns at
// most (keys × endpoints × days) rows — there is no pagination to get wrong and no cap to enforce.

import { apiUsageRepository } from "@leadwolf/db";
import { ValidationError } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const apiUsageRoutes = new Hono<{ Variables: TenancyVariables }>();

apiUsageRoutes.use("*", authn);
apiUsageRoutes.use("*", tenancy);

/** Windows the dashboard offers. An allow-list rather than a numeric range: an arbitrary `days` lets a caller
 *  ask for a decade and turn a bounded read into a scan. */
const ALLOWED_WINDOWS = new Set([7, 30, 90]);
const DEFAULT_WINDOW = 30;

apiUsageRoutes.get("/", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const raw = c.req.query("days");
  const days = raw === undefined ? DEFAULT_WINDOW : Number(raw);
  if (!ALLOWED_WINDOWS.has(days)) {
    throw new ValidationError("`days` must be one of 7, 30 or 90.");
  }

  const tenantId = c.get("tenantId");
  const [days_, totals] = await Promise.all([
    apiUsageRepository.recentForTenant(tenantId, days),
    apiUsageRepository.totalsForTenant(tenantId, days),
  ]);

  return c.json({
    windowDays: days,
    totals,
    // Buckets are returned raw (per key, per endpoint, per day). The client folds them for display — which
    // keeps this endpoint useful for a per-key breakdown as well as the chart, without a second round trip.
    days: days_,
  });
});
