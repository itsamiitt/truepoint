// rateLimit.ts — a coarse per-caller throttle for the resource API (mission §rate-limiting). Keyed by the
// verified subject when authn has run, else the client IP from the proxy headers. Backed by the shared Redis
// limiter in packages/auth (fails open on a Redis outage). Exhaustion → RateLimitedError → 429 Problem Details.

import { checkRequestRate } from "@leadwolf/auth";
import type { Context, Next } from "hono";

function clientKey(c: Context): string {
  // claims are set by authn when this runs inside an authenticated router; at the app root they're absent.
  const sub = (c.get("claims") as { sub?: string } | undefined)?.sub;
  if (sub) return `sub:${sub}`;
  const fwd = c.req.header("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
  return `ip:${ip}`;
}

export async function rateLimit(c: Context, next: Next): Promise<void> {
  await checkRequestRate(clientKey(c));
  await next();
}
