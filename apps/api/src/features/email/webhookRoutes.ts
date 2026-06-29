// webhookRoutes.ts — the PUBLIC email tracking surface (email-planning/13 P1/P3, 04). Session-less; the trust
// boundary is a SIGNATURE under a PER-TENANT key (P0 email-sec-001): the inbound ESP webhook is HMAC-verified
// with deriveEmailSigningKey('webhook', tenantId, root) and the open-pixel/click token with the per-tenant
// tracking key (verifyTrackingTokenScoped). Because the key is per-tenant, a payload that NAMES a tenant only
// verifies if it was signed with THAT tenant's key — so the tenant/workspace the route then uses to scope the
// RLS write is AUTHENTIC, not attacker-asserted (the global-secret forgery is closed). Verified bounce/complaint
// drive the UNCHANGED M9 handleBounce (suppression + credit-back); every event is recorded idempotently in
// email_event and open/click project into the activities timeline (ingestTrackingEvent). Mounted BEFORE the
// authed email router (its `*` authn would 401 these session-less calls), mirroring dsarPublicRoutes.

import { createHash } from "node:crypto";
import { env } from "@leadwolf/config";
import {
  deriveEmailSigningKey,
  handleBounce,
  ingestTrackingEvent,
  parseDeliveryEvent,
  verifyEmailWebhookSignature,
  verifyTrackingTokenScoped,
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
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }
  // P0 (email-sec-001): select the verification key from the CLAIMED tenant, then HMAC-verify the raw body
  // under THAT tenant's per-tenant key. A payload naming another tenant cannot be signed without that tenant's
  // key, so a passing signature makes the claimed tenant/workspace AUTHENTIC — the route never trusts
  // attacker-asserted scope. The claimed tenant is read from the unverified JSON ONLY to pick the key; nothing
  // is acted on until the signature passes.
  const claimedTenantId =
    typeof (parsedJson as { tenantId?: unknown } | null)?.tenantId === "string"
      ? (parsedJson as { tenantId: string }).tenantId
      : null;
  if (!claimedTenantId) return c.json({ ok: true }); // nothing to attribute → benign no-op
  const webhookKey = deriveEmailSigningKey("webhook", claimedTenantId, env.EMAIL_WEBHOOK_SECRET);
  if (!verifyEmailWebhookSignature(raw, c.req.header(SIGNATURE_HEADER), webhookKey)) {
    return c.json({ error: "invalid_signature" }, 400);
  }

  const event = parseDeliveryEvent(parsedJson);
  if (!event) return c.json({ ok: true }); // unknown/benign → 200 (no ESP retry storm)

  // event.tenantId is the signature-bound claimedTenantId → the scope is authentic, not attacker-asserted.
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
  const payload = verifyTrackingTokenScoped(c.req.param("token"), env.EMAIL_WEBHOOK_SECRET ?? "");
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
  const payload = verifyTrackingTokenScoped(c.req.param("token"), env.EMAIL_WEBHOOK_SECRET ?? "");
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
