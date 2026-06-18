// dispatch.ts — the outbound delivery engine (09 §10, 26 §4): sign a payload with the subscription's secret,
// POST it to the (SSRF-checked) target, and record the attempt in webhook_deliveries. Used by the self-test
// ping (POST /webhooks/:id/test) and replay (POST /webhooks/deliveries/:id/replay), and is the seam a real
// event emitter would call. Every attempt — even one that never leaves the box because the URL fails the
// SSRF re-check — is logged, so the delivery log is a faithful audit of what we tried. Workspace scope is
// the caller's; the repository RLS-scopes the writes.

import { type TenantScope, type WebhookDispatchTarget, webhookRepository } from "@leadwolf/db";
import { signWebhookPayload } from "./sign.ts";
import { SsrfError, assertSafeWebhookUrl } from "./ssrfGuard.ts";

const DELIVERY_TIMEOUT_MS = 10_000;

export interface DispatchInput {
  scope: TenantScope;
  /** The target subscription, incl. its encrypted secret (from webhookRepository.getDispatchTarget). */
  target: WebhookDispatchTarget;
  /** The recovered plaintext signing secret (core decrypts; never passed across the api boundary). */
  signingSecret: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface DispatchResult {
  deliveryId: string;
  status: "succeeded" | "failed";
  responseCode: number | null;
}

/**
 * Sign + POST a single event to one subscription and record the attempt. Never throws on a delivery failure
 * (a dead endpoint, a timeout, or an SSRF re-check rejection) — those are recorded as `failed` so the caller
 * (and the UI) sees the outcome, exactly like the inbound webhook returning 200 on an ignored event.
 */
export async function dispatchToSubscription(input: DispatchInput): Promise<DispatchResult> {
  const { scope, target, signingSecret, eventType, payload } = input;
  const body = JSON.stringify({
    id: cryptoRandomId(),
    type: eventType,
    createdAt: new Date().toISOString(),
    data: payload,
  });

  let status: "succeeded" | "failed" = "failed";
  let responseCode: number | null = null;

  try {
    // Re-validate the target at fire time — DNS may have changed since create (SSRF defence in depth).
    const url = await assertSafeWebhookUrl(target.url);
    const signature = signWebhookPayload(body, signingSecret);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-truepoint-signature": signature,
          "x-truepoint-event": eventType,
          "user-agent": "TruePoint-Webhooks/1",
        },
        body,
        // Never follow redirects — a 3xx to an internal host would bypass the validated-origin check (SSRF).
        redirect: "manual",
        signal: controller.signal,
      });
      responseCode = res.status;
      status = res.ok ? "succeeded" : "failed";
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // SsrfError (rejected target) and network/timeout errors both land here → recorded as failed, never thrown.
    status = "failed";
    responseCode = err instanceof SsrfError ? null : responseCode;
  }

  const deliveryId = await webhookRepository.insertDelivery(scope, {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId ?? "",
    webhookId: target.id,
    eventType,
    payload,
    status,
    responseCode,
  });

  return { deliveryId, status, responseCode };
}

/** A short opaque delivery/event id for the outbound payload envelope. */
function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
