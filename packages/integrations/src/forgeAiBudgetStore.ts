// forgeAiBudgetStore — the REAL AiBudgetStore implementing @leadwolf/forge-core's port on Redis (INCRBY +
// TTL), so the Forge extraction budget holds ACROSS worker instances. The in-memory store bounds one process,
// which means N workers bill N × the limit. Mirrors forgeRateLimiter's fixed-window shape.
//
// FAILS CLOSED, and that is the one place this deliberately differs from forgeRateLimiter.
//
// forgeRateLimiter fails OPEN on a Redis outage, with the right reasoning for what it guards: it throttles
// abuse, abuse is not a security boundary, and a Redis blip must never halt capture. This store guards
// something else — MONEY, on a path an outsider triggers by sending a capture. Failing open there re-opens
// precisely the unbounded-spend hole the budget exists to close, and it does so at the worst moment: an
// infrastructure incident, unattended, for as long as the outage lasts.
//
// Failing closed is also much cheaper here than it would be for capture. An unavailable budget makes
// runExtraction return `budget_exceeded`, which PARKS the job rather than failing it — the capture is already
// durably queued and the extraction runs when Redis returns. The cost of a false stop is delay; the cost of a
// false allow is an unbounded provider bill. Those are not symmetric, so they do not get the same default.

import type { AiBudgetStore } from "@leadwolf/forge-core";
import type { Redis } from "ioredis";

/** Key TTL. Comfortably longer than the budget window (a UTC day) so a counter cannot expire mid-window and
 *  silently hand a tenant a second full allowance; short enough that keys do not accumulate indefinitely. */
const BUDGET_KEY_TTL_SECONDS = 3 * 24 * 60 * 60;

/** Sentinel total returned when Redis cannot be reached. Above any sane limit, so the caller's
 *  `total > limit` check rejects — the fail-closed path. */
const UNAVAILABLE = Number.POSITIVE_INFINITY;

export function forgeAiBudgetStore(redis: Redis): AiBudgetStore {
  return {
    async reserve(key, units) {
      try {
        const total = await redis.incrby(key, units);
        // Set the TTL only on the write that created the key. `incrby` returning exactly `units` means the key
        // did not exist, so this cannot keep pushing the expiry out on every reservation — which would make a
        // busy tenant's window never roll over.
        if (total === units) await redis.expire(key, BUDGET_KEY_TTL_SECONDS);
        return total;
      } catch {
        return UNAVAILABLE; // fail CLOSED — see the header
      }
    },
    async release(key, units) {
      try {
        // A refund must not resurrect an expired window as a negative counter: DECRBY on a missing key creates
        // it at -units, and the next window would then start below zero and hand out free budget. Clamp at 0.
        const total = await redis.decrby(key, units);
        if (total < 0) await redis.set(key, 0, "EX", BUDGET_KEY_TTL_SECONDS);
      } catch {
        // A lost refund over-counts this tenant's usage for the rest of the window. That is the safe direction
        // for a spend cap, and it self-heals when the window rolls.
      }
    },
  };
}
