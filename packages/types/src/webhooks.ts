// webhooks.ts — shared vocabulary for outbound webhooks (09 §10, 26 §4, G-INT-5/G-INT-6, M10): the closed
// event enum (mirrored as a SQL CHECK in packages/db/src/schema/webhooks.ts — this file is the source of
// truth), the request schemas the api zod-parses, and the list DTOs the web client renders. Validation
// lives here; logic does not. Delivery status mirrors the webhook_deliveries CHECK.

import { z } from "zod";

// ── Event vocabulary (subset of 09 §10 reserved for the developer-settings slice; 12 §5) ───────────────
export const webhookEvent = z.enum([
  "reveal.completed",
  "score.updated",
  "outreach.status_changed",
  "auth.event",
]);
export type WebhookEvent = z.infer<typeof webhookEvent>;

/** Per-delivery outcome (mirrors webhook_deliveries.status CHECK). */
export const webhookDeliveryStatus = z.enum(["succeeded", "failed", "pending"]);
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatus>;

// ── Request schemas (09 §3 body naming: snake_case) ────────────────────────────────────────────────────
/**
 * POST /webhooks — subscribe an endpoint. The URL is re-validated for SSRF at create + every dispatch/replay
 * (core/webhooks/ssrfGuard.ts); the Zod check here only enforces a well-formed absolute http(s) URL so a
 * malformed value never reaches the guard.
 */
export const createWebhookSchema = z.object({
  url: z
    .string()
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "URL must be http(s)."),
  events: z.array(webhookEvent).min(1).max(webhookEvent.options.length),
});
export type CreateWebhookRequest = z.infer<typeof createWebhookSchema>;

// ── DTOs ───────────────────────────────────────────────────────────────────────────────────────────────
/** A subscription as listed (the secret is NEVER returned here — only once at create). */
export const webhookSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  events: z.array(webhookEvent),
  active: z.boolean(),
  /** Non-secret display prefix of the signing secret, e.g. "whsec_a1b2…". */
  secretPrefix: z.string(),
  createdAt: z.coerce.date(),
});
export type WebhookSubscription = z.infer<typeof webhookSchema>;

/** Returned ONCE on create — the full plaintext signing secret (whsec_…); never persisted in clear. */
export const webhookSecretSchema = z.object({
  id: z.string().uuid(),
  signingSecret: z.string(),
});
export type WebhookSecretResponse = z.infer<typeof webhookSecretSchema>;

/** One delivery-log entry (09 §10 — delivery log + replay). */
export const webhookDeliverySchema = z.object({
  id: z.string().uuid(),
  webhookId: z.string().uuid().nullable(),
  event: webhookEvent,
  status: webhookDeliveryStatus,
  responseCode: z.number().int().nullable(),
  attemptedAt: z.coerce.date(),
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;
