// webhooks.ts — the webhook domain operations the api routes call (09 §10, 26 §4, G-INT-5): create a
// subscription (generate + encrypt the secret, SSRF-check the URL, persist, return the plaintext ONCE),
// fire a self-test ping, and replay a past delivery. The signing/encryption/SSRF/POST primitives live in
// the sibling sign.ts / ssrfGuard.ts / dispatch.ts; this file is the orchestration + the secret lifecycle
// (plaintext exists only transiently here and is never returned by any read path).

import { type TenantScope, type WebhookDeliveryForReplay, webhookRepository } from "@leadwolf/db";
import { type DispatchResult, dispatchToSubscription } from "./dispatch.ts";
import {
  decryptSigningSecret,
  encryptSigningSecret,
  generateSigningSecret,
  secretPrefixOf,
} from "./sign.ts";
import { assertSafeWebhookUrl } from "./ssrfGuard.ts";

export { SsrfError } from "./ssrfGuard.ts";

export interface CreateSubscriptionInput {
  scope: TenantScope;
  url: string;
  events: string[];
  createdByUserId?: string | null;
}

export interface CreateSubscriptionResult {
  id: string;
  /** The one-time plaintext signing secret (whsec_…). Shown once; never persisted in clear. */
  signingSecret: string;
}

/**
 * Register a subscription: SSRF-validate the URL (throws {@link SsrfError} on an internal target), generate a
 * fresh signing secret, store it encrypted + a display prefix, and return the plaintext exactly once.
 */
export async function createWebhookSubscription(
  input: CreateSubscriptionInput,
): Promise<CreateSubscriptionResult> {
  await assertSafeWebhookUrl(input.url); // reject internal/loopback/metadata targets up front
  const signingSecret = generateSigningSecret();
  const id = await webhookRepository.insertSubscription(input.scope, {
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId ?? "",
    url: input.url,
    events: input.events,
    signingSecretEnc: encryptSigningSecret(signingSecret),
    secretPrefix: secretPrefixOf(signingSecret),
    createdByUserId: input.createdByUserId ?? null,
  });
  return { id, signingSecret };
}

export interface SendTestEventInput {
  scope: TenantScope;
  webhookId: string;
}

/** The synthetic event a self-test ping carries (an obvious, side-effect-free probe payload). */
function testPayload(): Record<string, unknown> {
  return { test: true, message: "TruePoint webhook self-test ping" };
}

/**
 * Fire a self-test ping at a subscription: a signed POST recorded in the delivery log. Returns null when the
 * subscription doesn't exist in the caller's workspace (RLS-scoped lookup) so the route can 404.
 */
export async function sendTestEvent(input: SendTestEventInput): Promise<DispatchResult | null> {
  const target = await webhookRepository.getDispatchTarget(input.scope, input.webhookId);
  if (!target) return null;
  const signingSecret = decryptSigningSecret(target.signingSecretEnc);
  return dispatchToSubscription({
    scope: input.scope,
    target,
    signingSecret,
    eventType: "webhook.test",
    payload: testPayload(),
  });
}

export interface ReplayDeliveryInput {
  scope: TenantScope;
  deliveryId: string;
}

export type ReplayOutcome =
  | { ok: true; result: DispatchResult }
  | { ok: false; reason: "delivery_not_found" | "subscription_gone" };

/**
 * Replay a past delivery: re-fetch its original event + payload, re-resolve the still-live subscription,
 * RE-SIGN with the current secret (the spec's "valid signature on replay"), POST, and record a NEW delivery
 * attempt. The replay never reuses a stored signature — it recomputes one — so a tampered/expired captured
 * signature can never be replayed; only a payload we still hold for a subscription we still own can be.
 */
export async function replayDelivery(input: ReplayDeliveryInput): Promise<ReplayOutcome> {
  const past: WebhookDeliveryForReplay | null = await webhookRepository.getDeliveryForReplay(
    input.scope,
    input.deliveryId,
  );
  if (!past) return { ok: false, reason: "delivery_not_found" };
  if (!past.webhookId) return { ok: false, reason: "subscription_gone" };

  const target = await webhookRepository.getDispatchTarget(input.scope, past.webhookId);
  if (!target) return { ok: false, reason: "subscription_gone" };

  const signingSecret = decryptSigningSecret(target.signingSecretEnc);
  const result = await dispatchToSubscription({
    scope: input.scope,
    target,
    signingSecret,
    eventType: past.eventType,
    payload: asRecord(past.payload),
  });
  return { ok: true, result };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
