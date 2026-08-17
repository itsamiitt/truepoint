// providerOrigins.ts — contracts for the data-source ORIGIN fleet console (provider_origins, 0117;
// /admin/data-sources). The API key crosses the wire ONCE, cleartext-in over TLS on create/update, is
// sealed server-side, and never appears in any response shape — the views carry the masked hint only.

import { z } from "zod";

export const originCreateSchema = z.object({
  label: z.string().min(1).max(100),
  baseUrl: z.string().url().max(500),
  /** Write-only: sealed (AES-GCM + "…tail" hint) before storage; never echoed. */
  apiKey: z.string().min(1).max(500).nullish(),
  priority: z.number().int().min(0).max(10_000).optional(),
});
export type OriginCreateInput = z.infer<typeof originCreateSchema>;

export const originPatchSchema = originCreateSchema.partial();
export type OriginPatchInput = z.infer<typeof originPatchSchema>;

export const originPauseSchema = z.object({ paused: z.boolean() });

/** The masked console view — key HINT only, never ciphertext, never the key. */
export const providerOriginViewSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  apiKeyHint: z.string().nullable(),
  priority: z.number().int(),
  paused: z.boolean(),
  lastOkAt: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
});
export type ProviderOriginView = z.infer<typeof providerOriginViewSchema>;
