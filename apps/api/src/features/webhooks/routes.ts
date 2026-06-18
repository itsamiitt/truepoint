// routes.ts — HTTP wiring for outbound webhooks (09 §10, 26 §4, G-INT-5; M10), mounted at /api/v1/webhooks.
// CRUD subscriptions (the signing secret is returned ONCE at create, never on a read), the delivery log,
// a self-test ping, and replay-from-log. Transport only: SSRF validation, signing, dispatch, and the
// secret lifecycle live in @leadwolf/core; workspace scoping is enforced by RLS in @leadwolf/db. Tenancy is
// derived from the verified JWT (never the body, 09 §1). API keys / OAuth apps live in a SEPARATE slice.
//
// Route order matters in Hono: the literal `/deliveries…` paths register BEFORE the `/:id…` patterns so a
// subscription id never shadows the delivery endpoints.

import {
  SsrfError,
  createWebhookSubscription,
  replayDelivery,
  sendTestEvent,
} from "@leadwolf/core";
import { webhookRepository } from "@leadwolf/db";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  createWebhookSchema,
  webhookEvent,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const webhooksRoutes = new Hono<{ Variables: TenancyVariables }>();

webhooksRoutes.use("*", authn);
webhooksRoutes.use("*", tenancy);

/** Resolve the active workspace or 403 — every webhook resource is workspace-scoped. */
function requireWorkspace(c: { get: (k: "workspaceId") => string | undefined }): string {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to manage webhooks.");
  return workspaceId;
}

// ── Delivery log + replay (register before /:id so they aren't shadowed) ────────────────────────────────
webhooksRoutes.get("/deliveries", async (c) => {
  const workspaceId = requireWorkspace(c);
  const tenantId = c.get("tenantId");
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
  const rows = await webhookRepository.listDeliveries({ tenantId, workspaceId }, limit);
  const deliveries = rows.map((d) => ({
    id: d.id,
    webhookId: d.webhookId,
    event: d.eventType,
    status: d.status,
    responseCode: d.responseCode,
    attemptedAt: d.attemptedAt,
  }));
  return c.json({ deliveries });
});

webhooksRoutes.post("/deliveries/:id/replay", async (c) => {
  const workspaceId = requireWorkspace(c);
  const tenantId = c.get("tenantId");
  const outcome = await replayDelivery({
    scope: { tenantId, workspaceId },
    deliveryId: c.req.param("id"),
  });
  if (!outcome.ok) {
    if (outcome.reason === "delivery_not_found") throw new NotFoundError("Delivery not found.");
    throw new NotFoundError("The subscription for this delivery no longer exists.");
  }
  return c.json({
    deliveryId: outcome.result.deliveryId,
    status: outcome.result.status,
    responseCode: outcome.result.responseCode,
  });
});

// ── Subscriptions ───────────────────────────────────────────────────────────────────────────────────────
webhooksRoutes.get("/", async (c) => {
  const workspaceId = requireWorkspace(c);
  const tenantId = c.get("tenantId");
  const rows = await webhookRepository.listSubscriptions({ tenantId, workspaceId });
  const webhooks = rows.map((w) => ({
    id: w.id,
    url: w.url,
    events: webhookEvent.options.filter((e) => w.events.includes(e)), // narrow to the closed enum for the UI
    active: w.active,
    secretPrefix: w.secretPrefix,
    createdAt: w.createdAt,
  }));
  return c.json({ webhooks });
});

webhooksRoutes.post("/", async (c) => {
  const workspaceId = requireWorkspace(c);
  const tenantId = c.get("tenantId");
  const parsed = createWebhookSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { url, events: [event, …] }.");

  try {
    const result = await createWebhookSubscription({
      scope: { tenantId, workspaceId },
      url: parsed.data.url,
      events: parsed.data.events,
      createdByUserId: c.get("claims").sub,
    });
    // The signing secret is returned ONCE here and never again (no read path exposes it).
    return c.json({ id: result.id, signingSecret: result.signingSecret }, 201);
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new ValidationError("That URL isn't an allowed webhook target.", {
        reason: err.message,
      });
    }
    throw err;
  }
});

webhooksRoutes.post("/:id/test", async (c) => {
  const workspaceId = requireWorkspace(c);
  const tenantId = c.get("tenantId");
  const result = await sendTestEvent({
    scope: { tenantId, workspaceId },
    webhookId: c.req.param("id"),
  });
  if (!result) throw new NotFoundError("Webhook not found.");
  return c.json({
    deliveryId: result.deliveryId,
    status: result.status,
    responseCode: result.responseCode,
  });
});

webhooksRoutes.delete("/:id", async (c) => {
  const workspaceId = requireWorkspace(c);
  const tenantId = c.get("tenantId");
  const removed = await webhookRepository.deleteSubscription(
    { tenantId, workspaceId },
    c.req.param("id"),
  );
  if (!removed) throw new NotFoundError("Webhook not found.");
  return c.json({ ok: true });
});
