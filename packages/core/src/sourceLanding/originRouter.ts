// originRouter.ts — loads the data-source origin fleet (provider_origins, 0117) for the fetch layer, with
// a short in-process TTL cache, and owns the SECRET boundary: ciphertext from the repository is decrypted
// HERE (core owns encryptPii/decryptPii; packages/db never sees a cleartext key).
//
// ENV FALLBACK, for dev and migration continuity: when the table holds ZERO rows for a provider, one
// synthetic origin is derived from LINKEDIN_API_BASE_URL/LINKEDIN_API_KEY (the pre-0117 single-origin
// config). The moment a real row exists, env is ignored — the console is the source of truth.
//
// The 60s TTL is the operator-latency contract: pausing an origin in the console takes effect fleet-wide
// within a minute without any push machinery. Callers never cache beyond this module.

import { env } from "@leadwolf/config";
import { providerOriginRepository, withPlatformReadTx, withPrivilegedTx } from "@leadwolf/db";
import { decryptPii, encryptPii } from "../import/encryptPii.ts";

export interface ResolvedOrigin {
  id: string | null; // null = the synthetic env-fallback origin (no health row to update)
  baseUrl: string;
  host: string;
  apiKey: string | null;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; origins: ResolvedOrigin[] }>();

/** Test seam: drop the cache so a test (or an admin mutation path) sees fresh rows immediately. */
export function invalidateOriginCache(provider?: string): void {
  if (provider) cache.delete(provider);
  else cache.clear();
}

function toResolved(row: {
  id: string;
  baseUrl: string;
  apiKeyEnc: Uint8Array | null;
}): ResolvedOrigin | null {
  let parsed: URL;
  try {
    parsed = new URL(row.baseUrl);
  } catch {
    return null; // an unparseable stored URL is skipped, never thrown — one bad row must not kill the chain
  }
  if (parsed.protocol !== "https:") return null;
  return {
    id: row.id,
    baseUrl: row.baseUrl.replace(/\/$/, ""),
    host: parsed.host,
    apiKey: row.apiKeyEnc ? decryptPii(row.apiKeyEnc) : null,
  };
}

function envFallback(provider: string): ResolvedOrigin[] {
  if (provider !== "linkedin_api" || !env.LINKEDIN_API_BASE_URL) return [];
  try {
    const parsed = new URL(env.LINKEDIN_API_BASE_URL);
    if (parsed.protocol !== "https:") return [];
    return [
      {
        id: null,
        baseUrl: env.LINKEDIN_API_BASE_URL.replace(/\/$/, ""),
        host: parsed.host,
        apiKey: env.LINKEDIN_API_KEY ?? null,
      },
    ];
  } catch {
    return [];
  }
}

/** The failover chain, priority-ordered, keys decrypted, ≤60s stale. */
export async function loadOrigins(provider: string): Promise<ResolvedOrigin[]> {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.origins;

  const rows = await withPlatformReadTx((tx) =>
    providerOriginRepository.listActiveWithKeys(tx, provider),
  );
  const resolved = rows.map(toResolved).filter((o): o is ResolvedOrigin => o !== null);
  const origins = resolved.length > 0 ? resolved : envFallback(provider);
  cache.set(provider, { at: Date.now(), origins });
  return origins;
}

/** Health write-back after a fetch attempt. Best-effort: a health write must never fail a fetch.
 *  Synthetic env origins (id null) have no row to update. withPrivilegedTx, not withSystemTx: this is
 *  per-attempt operational telemetry on a system-owned config table (the provider_calls posture), and an
 *  audit row per outbound HTTP attempt would turn platform_audit_log into a request log. */
export async function recordOriginOutcome(
  originId: string | null,
  ok: boolean,
  error?: string,
): Promise<void> {
  if (!originId) return;
  try {
    await withPrivilegedTx((tx) => providerOriginRepository.recordOutcome(tx, originId, ok, error));
  } catch (e) {
    console.error("[originRouter] health write-back failed (non-fatal)", e);
  }
}

/** The console's key-ingest boundary: cleartext key → {ciphertext, masked hint}. Lives here so apps/api
 *  never touches crypto primitives directly and the hint format stays uniform. */
export function sealOriginKey(key: string): { apiKeyEnc: Uint8Array; apiKeyHint: string } {
  const tail = key.slice(-4);
  return { apiKeyEnc: encryptPii(key), apiKeyHint: `…${tail}` };
}
