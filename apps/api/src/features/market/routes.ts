// routes.ts — the market-segment board read (market-intelligence MI-S7; mounted at /api/v1/market).
// Serves the master_market_rollups cache under withErTx: NON-PII graph aggregates by construction
// (counts and sums over industry × country × band × month) — market context any authenticated customer
// may see; no tenant data, no ids, no drill-down payload (drill-down is a normal account search, which
// is how every board number stays reconcilable). Honest while dark: MARKET_ROLLUPS_ENABLED off ⇒
// enabled:false + empty board, never a fabricated zero.

import { env } from "@leadwolf/config";
import { type Tx, marketRollupRepository, masterIndustryRepository, withErTx } from "@leadwolf/db";
import { ValidationError, marketSegmentsResponse } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, requireWorkspace, tenancy } from "../../middleware/tenancy.ts";

export const marketRoutes = new Hono<{ Variables: TenancyVariables }>();

marketRoutes.use("*", authn);
marketRoutes.use("*", tenancy);

marketRoutes.get("/segments", async (c) => {
  requireWorkspace(c); // authenticated, workspace-selected customers only — the board is a product surface
  if (!env.MARKET_ROLLUPS_ENABLED) {
    return c.json(marketSegmentsResponse.parse({ enabled: false, segments: [] }));
  }
  const monthsRaw = c.req.query("months");
  const months = monthsRaw === undefined ? 6 : Number.parseInt(monthsRaw, 10);
  if (!Number.isInteger(months) || months < 1 || months > 24) {
    throw new ValidationError("months must be an integer in [1, 24].");
  }

  const [segments, industries] = await withErTx(async (tx: Tx) =>
    Promise.all([
      marketRollupRepository.readSegments(tx, { months }),
      masterIndustryRepository.listAll(tx),
    ]),
  );
  const labels = new Map(industries.map((i) => [i.code, i.label]));

  return c.json(
    marketSegmentsResponse.parse({
      enabled: true,
      segments: segments.map((s) => ({
        ...s,
        industryLabel: s.industryCode
          ? (labels.get(s.industryCode) ?? s.industryCode)
          : "Unclassified",
      })),
    }),
  );
});
