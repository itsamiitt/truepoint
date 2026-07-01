// revealRateLimit.ts — a per-caller burst throttle for the reveal MONEY endpoint, applied ON TOP of the coarse
// /api limiter. Keyed by the verified subject (authn has already run for this router), backed by checkRevealRate
// (RateLimitedError → 429; fails OPEN on a Redis outage — the credit-balance CHECK is the hard spend cap). A
// runaway script / compromised token is bounded by request velocity, not only by the balance.

import { checkRevealRate } from "@leadwolf/auth";
import type { Context, Next } from "hono";

export async function revealRateLimit(c: Context, next: Next): Promise<void> {
  const sub = (c.get("claims") as { sub?: string } | undefined)?.sub;
  if (sub) await checkRevealRate(`reveal:${sub}`);
  await next();
}
