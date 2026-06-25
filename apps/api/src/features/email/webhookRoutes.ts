// webhookRoutes.ts — the PUBLIC inbound ESP delivery/bounce/complaint webhook (email-planning/13 P1, 04 §6,
// 08 §6). Session-less like the Stripe webhook: there is no user, the HMAC SIGNATURE is the trust boundary
// (verifyEmailWebhookSignature against EMAIL_WEBHOOK_SECRET — fail closed when the secret is unset). A
// verified bounce/complaint drives the UNCHANGED M9 handleBounce (→ suppression row + ADR-0013 credit-back),
// which is replay-idempotent and RLS-scoped to the workspace the signed event names — so a forged tenant id
// cannot reach another tenant's data. Mounted BEFORE the authed email router (its `*` authn would otherwise
// 401 this session-less call), mirroring dsarPublicRoutes.

import { env } from "@leadwolf/config";
import { handleBounce, parseDeliveryEvent, verifyEmailWebhookSignature } from "@leadwolf/core";
import { Hono } from "hono";

export const emailWebhookRoutes = new Hono();

const SIGNATURE_HEADER = "x-tp-email-signature";

emailWebhookRoutes.post("/delivery", async (c) => {
  // Read the RAW body for signature verification (must hash exactly what the ESP signed).
  const raw = await c.req.text();
  const ok = verifyEmailWebhookSignature(
    raw,
    c.req.header(SIGNATURE_HEADER),
    env.EMAIL_WEBHOOK_SECRET ?? "",
  );
  if (!ok) {
    // Fail closed: unsigned/forged/replayed (or no secret configured) → reject. No PII logged.
    return c.json({ error: "invalid_signature" }, 400);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }

  const event = parseDeliveryEvent(parsedJson);
  // Unknown/benign event shape → 200 so the ESP does not retry it forever.
  if (!event) return c.json({ ok: true });

  // A bounce/complaint with an enrollment drives the M9 handleBounce (idempotent on already-bounced).
  if ((event.type === "bounce" || event.type === "complaint") && event.outreachLogId) {
    await handleBounce({
      scope: { tenantId: event.tenantId, workspaceId: event.workspaceId },
      logId: event.outreachLogId,
    });
  }
  // (delivery events feed the email_event tracking store at P3; acknowledged here.)
  return c.json({ ok: true });
});
