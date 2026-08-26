// linkedinLinkFetchSweep.ts — the scheduled, leader-locked PLATFORM sweep that fetches every LinkedIn URL
// in the fetch registry (source_fetch_registry, 0118) that is new or older than 30 days, from the
// linkedin_api origin fleet, and lands it (docs/planning ecosystem work).
//
// This replaces the retry-storm-prone "missing this month's headcount point" enumeration with a real
// per-URL 30-day clock: a URL is fetched at most once per FRESHNESS_DAYS, a failing URL still advances its
// clock (recordFetch on every attempt) so it rotates off the sweep head, and a person landing derives its
// employer company URLs into the same registry for the same sweep to pick up. Layer-0 lane — no tenant, no
// provider_calls ledger (the linkedinCompanyRefresh rationale); structural cost bound = cap × cadence ×
// registry dedup.
//
// Triple-dark: registered only when LINKEDIN_LINK_FETCH_ENABLED, an empty origin fleet skips every fetch,
// and the landing no-ops unless LINKEDIN_SOURCE_LANDING_ENABLED.

import { env } from "@leadwolf/config";
import {
  FRESHNESS_DAYS,
  type FetchAndLandOutcome,
  fetchAndLandUrl,
  loadOrigins,
  lookupInterestKey,
  lookupUpdatedPayload,
  parseLookupInterestMember,
} from "@leadwolf/core";
import {
  eventOutboxRepository,
  sourceFetchRegistryRepository,
  withPrivilegedTx,
  withTenantTx,
} from "@leadwolf/db";
import { EVENT_CONTACT_LOOKUP_UPDATED } from "@leadwolf/types";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const LINKEDIN_LINK_FETCH_QUEUE = "linkedin_link_fetch";
const LEADER_KEY = "leader:linkedin_link_fetch";
const LEADER_TTL_MS = 10 * 60_000;
// Persons + companies each get their own bounded slice per tick (operator-tunable; slice 9).
const MAX_PER_KIND_PER_TICK = env.LINKEDIN_LINK_FETCH_BATCH;
// Origin-down backoff: after this many consecutive all-unavailable ticks, skip ticks until the next
// success (a Redis flag with a TTL) — a dead fleet must not burn a full batch of registry clocks hourly.
const BACKOFF_AFTER_CONSECUTIVE_UNAVAILABLE = 5;
const BACKOFF_KEY = "linkedin_link_fetch:unavailable_streak";
const BACKOFF_SKIP_KEY = "linkedin_link_fetch:backoff";
const BACKOFF_TTL_S = 30 * 60;

export type LinkedinLinkFetchJobData = Record<string, never>;

export function makeProcessLinkedinLinkFetch(redis: IORedis) {
  return async function processLinkedinLinkFetch(
    _job: Job<LinkedinLinkFetchJobData>,
  ): Promise<void> {
    if (!env.LINKEDIN_LINK_FETCH_ENABLED || !env.LINKEDIN_SOURCE_LANDING_ENABLED) return;
    if ((await loadOrigins("linkedin_api")).length === 0) {
      log.info("linkedin link fetch skipped (no active origin)");
      return;
    }

    // Origin-down backoff (slice 9): a fleet returning nothing but `unavailable` for several consecutive
    // ticks sets a TTL'd skip flag — the sweep goes quiet for BACKOFF_TTL_S instead of burning a batch of
    // registry clocks every tick against a dead vendor. Any success clears the streak.
    if (await redis.get(BACKOFF_SKIP_KEY)) {
      log.info("linkedin link fetch skipped (origin backoff)");
      return;
    }

    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      let landed = 0;
      let skipped = 0;
      let unavailable = 0;
      // The smallest fleet cooldown horizon any fetch reported this tick (unavailable + retryAfterMs) —
      // a HINTED outage backs the sweep off immediately for exactly that long, no 5-tick streak needed.
      let minRetryAfterMs: number | undefined;
      // Persons first (they DERIVE company targets), then companies — so a company minted this tick can be
      // fetched next tick, not starved.
      for (const kind of ["person", "company"] as const) {
        const due = await withPrivilegedTx((tx) =>
          sourceFetchRegistryRepository.listDueForFetch(
            tx,
            kind,
            FRESHNESS_DAYS,
            MAX_PER_KIND_PER_TICK,
          ),
        );
        for (const target of due) {
          try {
            const result = await fetchAndLandUrl({
              entityKind: kind,
              normalizedUrl: target.normalizedUrl,
              externalId: target.externalId,
            });
            if (result.outcome === "landed" || result.outcome === "duplicate") landed += 1;
            else skipped += 1;
            if (result.outcome === "unavailable") {
              unavailable += 1;
              if (result.retryAfterMs !== undefined) {
                minRetryAfterMs = Math.min(
                  minRetryAfterMs ?? Number.POSITIVE_INFINITY,
                  result.retryAfterMs,
                );
              }
            }
            // Notify any workspace that viewed this URL in the extension and is waiting for the refresh
            // (chrome-extension/15 §13). Dark until REALTIME_SSE_ENABLED; a no-op when no one is interested.
            await notifyInterestedWorkspaces(redis, target.normalizedUrl, result.outcome);
          } catch (e) {
            // One URL's failure must not starve the tick; the registry clock was NOT advanced (fetchAndLand
            // stamps inside its own tx), so the next tick retries it.
            skipped += 1;
            log.error("linkedin link fetch: per-url failure", {
              url: target.normalizedUrl,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      // Streak accounting: an all-unavailable non-empty tick bumps the streak; anything landing resets it.
      if (landed > 0) {
        await redis.del(BACKOFF_KEY);
      } else if (unavailable > 0 && minRetryAfterMs !== undefined) {
        // HINTED backoff (the classifier's throttle/outage horizon): the fleet said when to come back —
        // believe it now instead of burning 4 more ticks' registry clocks to prove the streak. Clamped so
        // one bad header can't silence the sweep beyond the origin-cooldown ceiling.
        const seconds = Math.min(
          Math.max(60, Math.ceil(minRetryAfterMs / 1000)),
          Math.ceil(env.ENRICH_ORIGIN_COOLDOWN_MAX_MS / 1000),
        );
        await redis.set(BACKOFF_SKIP_KEY, "1", "EX", seconds);
        await redis.del(BACKOFF_KEY);
        log.warn("linkedin link fetch: origin fleet throttled/cooling — backing off on its hint", {
          backoffSeconds: seconds,
        });
      } else if (unavailable > 0 && unavailable === skipped) {
        const streak = await redis.incr(BACKOFF_KEY);
        if (streak >= BACKOFF_AFTER_CONSECUTIVE_UNAVAILABLE) {
          await redis.set(BACKOFF_SKIP_KEY, "1", "EX", BACKOFF_TTL_S);
          await redis.del(BACKOFF_KEY);
          log.warn("linkedin link fetch: origin fleet unavailable — backing off", {
            streak,
            backoffSeconds: BACKOFF_TTL_S,
          });
        }
      }
      log.info("linkedin link fetch tick", { landed, skipped, unavailable });
    });
  };
}

/** Emit `contact.lookup_updated` to every workspace that SADDed interest in this URL via `/lookup`, then clear
 *  the set (chrome-extension/15 §13, option D). Best-effort per the §13 D7 boundary — this is a notification,
 *  not a fact: it lives OUTSIDE the landing tx and a failure must never break the sweep (the extension's poll
 *  re-check is the safety net). Only outcomes that leave current data present are worth a nudge; a
 *  rejected/unavailable fetch changed nothing to re-read (the sweep retries; poll covers the gap). */
async function notifyInterestedWorkspaces(
  redis: IORedis,
  normalizedUrl: string,
  fetchOutcome: FetchAndLandOutcome,
): Promise<void> {
  if (!env.REALTIME_SSE_ENABLED) return;
  // NOT "fresh" (perf-checklist PA-11): fresh means "within the freshness window — no vendor call, nothing
  // changed" (fetchAndLand), and pushing it as "refreshed" drove the extension through a guaranteed-no-op
  // invalidate → full /lookup re-resolve returning byte-identical data. Only outcomes that changed what a
  // re-read would see are worth a nudge.
  if (fetchOutcome !== "landed" && fetchOutcome !== "duplicate") return;

  const key = lookupInterestKey(normalizedUrl);
  const members = await redis.smembers(key);
  if (members.length === 0) return;

  const payload = lookupUpdatedPayload(
    normalizedUrl,
    fetchOutcome === "landed" ? "landed" : "refreshed",
  );
  // A company URL (or an unaddressable one) yields no person payload — drop the interest, nothing to send.
  if (payload) {
    // BOUNDED fan-out (perf-checklist PA-11): the interest set has no cardinality cap at SADD time, and this
    // loop runs one sequential tenant transaction per member INSIDE the leader-locked sweep — a widely-viewed
    // profile (a well-known exec worked by many tenants in one 5-min window) could stall the whole tick.
    // Past the cap the push is skipped for the remainder and the extension's poll safety net covers them —
    // refusing is honest, starving the sweep is not (the events route's stream cap makes the same call).
    const MAX_PUSH_MEMBERS = 100;
    if (members.length > MAX_PUSH_MEMBERS) {
      log.warn("linkedin link fetch: interest set over push cap — remainder covered by poll", {
        url: normalizedUrl,
        members: members.length,
        cap: MAX_PUSH_MEMBERS,
      });
    }
    for (const member of members.slice(0, MAX_PUSH_MEMBERS)) {
      const scope = parseLookupInterestMember(member);
      if (!scope) continue;
      try {
        await withTenantTx(scope, (tx) =>
          eventOutboxRepository.append(tx, {
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            eventType: EVENT_CONTACT_LOOKUP_UPDATED,
            payload: payload as unknown as Record<string, unknown>,
          }),
        );
      } catch (e) {
        log.error("linkedin link fetch: lookup-updated emit failed", {
          url: normalizedUrl,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  await redis.del(key);
}
