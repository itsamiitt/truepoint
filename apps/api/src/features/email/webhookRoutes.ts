// webhookRoutes.ts — the PUBLIC email tracking surface (email-planning/13 P1/P3, 04). Session-less; the trust
// boundary is a SIGNATURE: the inbound ESP webhook is HMAC-verified (EMAIL_WEBHOOK_SECRET, fail closed), and
// the open-pixel / click-redirect carry an HMAC-signed token (verifyTrackingToken) so a recipient cannot forge
// a tracking hit. Verified bounce/complaint drive the UNCHANGED M9 handleBounce (suppression + credit-back);
// every event is recorded idempotently in email_event and open/click project into the activities timeline
// (ingestTrackingEvent). RLS scopes every write to the workspace the signed token/event names. Mounted BEFORE
// the authed email router (its `*` authn would 401 these session-less calls), mirroring dsarPublicRoutes.

import { createHash } from "node:crypto";
import { env } from "@leadwolf/config";
import {
  handleBounce,
  ingestTrackingEvent,
  parseDeliveryEvent,
  verifyEmailWebhookSignature,
  verifyTrackingToken,
} from "@leadwolf/core";
import { Hono } from "hono";

export const emailWebhookRoutes = new Hono();

const SIGNATURE_HEADER = "x-tp-email-signature";
// 1×1 transparent GIF — the open pixel body, as a standalone ArrayBuffer (what Hono's c.body accepts).
const PIXEL_BYTES = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
const PIXEL = PIXEL_BYTES.buffer.slice(
  PIXEL_BYTES.byteOffset,
  PIXEL_BYTES.byteOffset + PIXEL_BYTES.byteLength,
);

/** Apple MPP / proxy prefetch heuristic (D6): a proxied open has no real UA or a known image-proxy UA. */
function looksProxied(ua: string | undefined): boolean {
  if (!ua) return true;
  return /GoogleImageProxy|YahooMailProxy|Apple-?Mail|ImageProxy/i.test(ua);
}

// ── Inbound ESP webhook: delivery / bounce / complaint (HMAC-signed) ────────────────────────────────────
emailWebhookRoutes.post("/delivery", async (c) => {
  const raw = await c.req.text(); // RAW body — hash exactly what the ESP signed
  if (
    !verifyEmailWebhookSignature(
      raw,
      c.req.header(SIGNATURE_HEADER),
      env.EMAIL_WEBHOOK_SECRET ?? "",
    )
  ) {
    return c.json({ error: "invalid_signature" }, 400);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }
  const event = parseDeliveryEvent(parsedJson);
  if (!event) return c.json({ ok: true }); // unknown/benign → 200 (no ESP retry storm)

  const scope = { tenantId: event.tenantId, workspaceId: event.workspaceId };
  // Bounce/complaint → the M9 handleBounce (suppression + ADR-0013 credit-back), idempotent.
  if ((event.type === "bounce" || event.type === "complaint") && event.outreachLogId) {
    await handleBounce({ scope, logId: event.outreachLogId });
  }
  // Record every event in the tracking store (idempotent on the provider event id).
  await ingestTrackingEvent(scope, {
    type: event.type,
    contactId: null,
    outreachLogId: event.outreachLogId,
    messageId: event.messageId,
    providerEventId: event.providerEventId,
  });
  return c.json({ ok: true });
});

// ── Open pixel (signed token) — first-open-only, idempotent; always returns the gif ─────────────────────
emailWebhookRoutes.get("/open/:token", async (c) => {
  const payload = verifyTrackingToken(c.req.param("token"), env.EMAIL_WEBHOOK_SECRET ?? "");
  if (payload) {
    // Best-effort: a tracking failure must never break the pixel render.
    await ingestTrackingEvent(
      { tenantId: payload.tenantId, workspaceId: payload.workspaceId },
      {
        type: "open",
        contactId: payload.contactId,
        outreachLogId: payload.outreachLogId,
        messageId: payload.messageId ?? null,
        providerEventId: `open:${payload.outreachLogId}`, // deterministic → first-open-only (D6)
        isMppSuspected: looksProxied(c.req.header("user-agent")),
      },
    ).catch(() => {});
  }
  c.header("content-type", "image/gif");
  c.header("cache-control", "no-store, no-cache, must-revalidate, private");
  return c.body(PIXEL);
});

// ── Click redirect (signed token) — records the click, then 302s to a validated http(s) destination ─────
emailWebhookRoutes.get("/click/:token", async (c) => {
  const url = c.req.query("u");
  const payload = verifyTrackingToken(c.req.param("token"), env.EMAIL_WEBHOOK_SECRET ?? "");
  if (payload && url) {
    const urlHash = createHash("sha256").update(url).digest("hex").slice(0, 16);
    await ingestTrackingEvent(
      { tenantId: payload.tenantId, workspaceId: payload.workspaceId },
      {
        type: "click",
        contactId: payload.contactId,
        outreachLogId: payload.outreachLogId,
        messageId: payload.messageId ?? null,
        providerEventId: `click:${payload.outreachLogId}:${urlHash}`,
        metadata: { url },
      },
    ).catch(() => {});
  }
  // Open-redirect guard: only ever 302 to an http(s) URL.
  if (url && /^https?:\/\//i.test(url)) return c.redirect(url, 302);
  return c.json({ error: "invalid_link" }, 400);
});
