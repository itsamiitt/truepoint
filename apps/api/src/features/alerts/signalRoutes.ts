// signalRoutes.ts — the tenant signal feed read (market-intelligence MI-S6; mounted at /api/v1/signals).
// Reads tenant_signals ONLY — the workspace's delivered copy under RLS. Never touches Layer 0: the
// projection carries the display slice, and anything richer stays behind the account-intelligence
// resolve-then-traverse seams. Company facts only; no personal data crosses this boundary.

import { type Tx, tenantSignalsRepository, withTenantTx } from "@leadwolf/db";
import { ValidationError, signalFeedResponse } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, requireWorkspace, tenancy } from "../../middleware/tenancy.ts";

export const signalRoutes = new Hono<{ Variables: TenancyVariables }>();

signalRoutes.use("*", authn);
signalRoutes.use("*", tenancy);

signalRoutes.get("/", async (c) => {
  const workspaceId = requireWorkspace(c);
  const accountId = c.req.query("accountId");
  if (accountId !== undefined && !/^[0-9a-f-]{36}$/i.test(accountId)) {
    throw new ValidationError("accountId must be a uuid.");
  }
  const limitRaw = c.req.query("limit");
  const limit = limitRaw === undefined ? 50 : Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ValidationError("limit must be an integer in [1, 200].");
  }
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const signals = await withTenantTx(scope, (tx: Tx) =>
    tenantSignalsRepository.listRecent(tx, { accountId, limit }),
  );
  return c.json(
    signalFeedResponse.parse({
      signals: signals.map((s) => ({
        id: s.id,
        accountId: s.accountId,
        contactId: s.contactId,
        typeCode: s.typeCode,
        family: s.family,
        headline: s.headline,
        amountMinor: s.amountMinor,
        currency: s.currency,
        observedAt: s.observedAt.toISOString(),
        deliveredAt: s.deliveredAt.toISOString(),
      })),
    }),
  );
});
