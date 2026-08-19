// watchlistRoutes.ts — HTTP wiring for account watchlists + signal subscriptions (market-intelligence
// MI-S5; mounted at /api/v1/watchlists). Transport only: scope comes from the VERIFIED token (never the
// body), the caller user id is claims.sub, validation is the @leadwolf/types zod schemas, and RLS scoping
// lives in the repository layer under withTenantTx. Every write is role-gated; the subscription endpoint
// writes the CALLER's subscription only — one user cannot subscribe another (alert hygiene is personal).

import { type Tx, watchlistRepository, withTenantTx } from "@leadwolf/db";
import {
  NotFoundError,
  ValidationError,
  addWatchlistMemberSchema,
  createWatchlistSchema,
  signalSubscribeSchema,
  watchlistsResponse,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, requireWorkspace, tenancy } from "../../middleware/tenancy.ts";

export const watchlistRoutes = new Hono<{ Variables: TenancyVariables }>();

watchlistRoutes.use("*", authn);
watchlistRoutes.use("*", tenancy);

watchlistRoutes.get("/", async (c) => {
  const workspaceId = requireWorkspace(c);
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const watchlists = await withTenantTx(scope, (tx: Tx) => watchlistRepository.list(tx));
  return c.json(
    watchlistsResponse.parse({
      watchlists: watchlists.map((w) => ({
        id: w.id,
        name: w.name,
        memberCount: w.memberCount,
        createdAt: w.createdAt.toISOString(),
      })),
    }),
  );
});

watchlistRoutes.post("/", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = createWatchlistSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { name }.");
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const id = await withTenantTx(scope, (tx: Tx) =>
    watchlistRepository.create(tx, {
      ...scope,
      name: parsed.data.name,
      createdByUserId: c.get("claims").sub,
    }),
  );
  return c.json({ id }, 201);
});

watchlistRoutes.delete("/:id", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = requireWorkspace(c);
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const removed = await withTenantTx(scope, (tx: Tx) =>
    watchlistRepository.remove(tx, c.req.param("id")),
  );
  if (!removed) throw new NotFoundError("Watchlist not found.");
  return c.body(null, 204);
});

watchlistRoutes.get("/:id/members", async (c) => {
  const workspaceId = requireWorkspace(c);
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const accountIds = await withTenantTx(scope, (tx: Tx) =>
    watchlistRepository.listMemberAccountIds(tx, c.req.param("id")),
  );
  return c.json({ accountIds });
});

watchlistRoutes.post("/:id/members", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = addWatchlistMemberSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { accountId }.");
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  // Idempotent: re-adding returns 204 like a fresh add — the caller cares that the account is watched,
  // not whether it already was. A dangling watchlist/account id simply inserts nothing (RLS + the
  // deleted_at guard in the INSERT..SELECT), which is indistinguishable from already-present by design.
  await withTenantTx(scope, (tx: Tx) =>
    watchlistRepository.addMember(tx, {
      ...scope,
      watchlistId: c.req.param("id"),
      accountId: parsed.data.accountId,
      addedByUserId: c.get("claims").sub,
    }),
  );
  return c.body(null, 204);
});

watchlistRoutes.delete(
  "/:id/members/:accountId",
  requireRole("owner", "admin", "member"),
  async (c) => {
    const workspaceId = requireWorkspace(c);
    const scope = { tenantId: c.get("tenantId"), workspaceId };
    await withTenantTx(scope, (tx: Tx) =>
      watchlistRepository.removeMember(tx, c.req.param("id"), c.req.param("accountId")),
    );
    return c.body(null, 204);
  },
);

// The CALLER's subscription on this watchlist. PUT (idempotent upsert); families [] = paused.
watchlistRoutes.put("/:id/subscription", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = signalSubscribeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { families: SignalFamily[] }.");
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  await withTenantTx(scope, (tx: Tx) =>
    watchlistRepository.subscribe(tx, {
      ...scope,
      watchlistId: c.req.param("id"),
      userId: c.get("claims").sub,
      families: parsed.data.families,
    }),
  );
  return c.body(null, 204);
});
