// apiKeys.ts — the wire contract for machine API credentials (09 §1 "Auth (machine/public)", §4; ADR-0049).
//
// This contract is NOT new. apps/web/src/features/settings-developer has shipped against it since M10 and has
// been showing "API keys connect once the developer API ships" because the backend answers 404. The shapes
// below are therefore transcribed from that client, not designed fresh: `prefix` (not keyPrefix), ISO-string
// timestamps, `{ keys }` on the list, `{ id, secret }` on create/rotate. Changing any of them breaks a
// surface that already exists.

import { z } from "zod";

/**
 * The published scope vocabulary (09 §4). A scope gates an endpoint family; a key minted for read-only search
 * cannot be replayed against a billable reveal, which makes scopes a SPEND control and not merely an access
 * nicety — an integration key without that split can drain a tenant's credit balance through an automation
 * loop with no human in it.
 *
 * `enrich:write` is accepted here though the shipped picker offers only the other four: 09 §4 names it, and a
 * scope whose endpoints are not built yet simply gates nothing until they are.
 */
export const apiKeyScopeSchema = z.enum([
  "search:read",
  "reveal:write",
  "enrich:write",
  "outreach:write",
  "export:write",
]);
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

/** A key as the management surface sees it. NEVER carries the secret or its hash. */
export const apiKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Non-secret display fragment, e.g. "tp_live_a1b2c3d4". Never an authentication input. */
  prefix: z.string(),
  scopes: z.array(apiKeyScopeSchema),
  /** ISO-8601, or null when the key has never authenticated a call. */
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiKeyRecord = z.infer<typeof apiKeySchema>;

export const apiKeyListResponseSchema = z.object({ keys: z.array(apiKeySchema) });
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;

/**
 * Create input. Deliberately has NO tenantId and NO workspaceId: both come from the caller's verified session
 * (tenancy.md — "scope comes from the credential, never the request"). A body-supplied workspace would let a
 * member mint a key for a workspace they cannot otherwise reach.
 */
export const createApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // At least one scope: a key that can do nothing is a credential to leak for no benefit.
  scopes: z.array(apiKeyScopeSchema).min(1).max(16),
});
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

/**
 * The one-and-only time the plaintext secret is returned. It is never stored, never logged, and cannot be
 * recovered — a lost key is rotated, not looked up.
 */
export const apiKeySecretResponseSchema = z.object({
  id: z.string().uuid(),
  secret: z.string(),
});
export type ApiKeySecretResponse = z.infer<typeof apiKeySecretResponseSchema>;

// ── Usage (the dashboard read) ───────────────────────────────────────────────────────────────────────────

/** One (key, day, endpoint) bucket. The rollup grain, returned raw so a client can fold it either way. */
export const apiUsageBucketSchema = z.object({
  day: z.string(),
  endpoint: z.string(),
  apiKeyId: z.string().uuid(),
  calls: z.number().int().nonnegative(),
  /** The subset that returned data and therefore cost credits. */
  billedCalls: z.number().int().nonnegative(),
  creditsSpent: z.number().int().nonnegative(),
});
export type ApiUsageBucket = z.infer<typeof apiUsageBucketSchema>;

export const apiUsageTotalsSchema = z.object({
  calls: z.number().int().nonnegative(),
  billedCalls: z.number().int().nonnegative(),
  creditsSpent: z.number().int().nonnegative(),
});
export type ApiUsageTotalsWire = z.infer<typeof apiUsageTotalsSchema>;

export const apiUsageResponseSchema = z.object({
  windowDays: z.number().int().positive(),
  totals: apiUsageTotalsSchema,
  days: z.array(apiUsageBucketSchema),
});
export type ApiUsageResponse = z.infer<typeof apiUsageResponseSchema>;

/** Windows the usage endpoint accepts. An allow-list, not a range: an arbitrary `days` lets a caller ask for
 *  a decade and turn a bounded read into a scan. */
export const API_USAGE_WINDOWS = [7, 30, 90] as const;
export type ApiUsageWindow = (typeof API_USAGE_WINDOWS)[number];

/** The prefix shown in the management list and safe to echo in a customer's own logs. */
export const API_KEY_DISPLAY_PREFIX_LENGTH = 16;

/** Live-key prefix. A separate `tp_test_` band is reserved for the sandbox keys 09 §8 anticipates. */
export const API_KEY_LIVE_PREFIX = "tp_live_";
