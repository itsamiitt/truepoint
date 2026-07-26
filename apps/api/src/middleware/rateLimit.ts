// rateLimit.ts — a coarse per-caller throttle for the resource API (mission §rate-limiting). Keyed by the
// verified subject when authn has already populated claims, else the client IP from the proxy headers. Backed
// by the shared Redis limiter in packages/auth (fails open on a Redis outage). Exhaustion → RateLimitedError
// → 429 Problem Details.
//
// Deliberately does NOT verify the JWT itself (perf RC#11a): the rate-limit bucket is not a security boundary,
// and authn — the real boundary — already verifies the token per-router. Verifying here too would run the JWT
// crypto (and a possible JWKS fetch) twice on every authenticated request, in front of the throttle, which is
// the opposite of the perf goal. So we key by `sub` whenever claims are present (set by an authn that has
// already run for this request) and fall back to a coarse IP key otherwise. Read-only — no limit is weakened.

import { checkRequestRate, clientIpFromHeaders } from "@leadwolf/auth";
import type { Context, Next } from "hono";

function clientKey(c: Context): string {
  // claims are set by authn when this runs inside (or after) an authenticated router; absent at the app root.
  const sub = (c.get("claims") as { sub?: string } | undefined)?.sub;
  if (sub) return `sub:${sub}`;
  // IP fallback. This MUST use the trusted-hop rule, not the first X-Forwarded-For entry: each trusted proxy
  // APPENDS to that header rather than replacing it, so the leftmost value is whatever the client sent. Reading
  // it made the throttle trivially evadable — send a different X-Forwarded-For per request and every request
  // gets a fresh bucket. This is the exact bypass already fixed on the auth origin (W10/#14); it now shares that
  // implementation from @leadwolf/auth instead of keeping a second, weaker copy here.
  return `ip:${clientIpFromHeaders({ get: (name) => c.req.header(name) ?? null })}`;
}

export async function rateLimit(c: Context, next: Next): Promise<void> {
  await checkRequestRate(clientKey(c));
  await next();
}
