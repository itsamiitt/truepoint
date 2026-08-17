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
import { FRESHNESS_DAYS, fetchAndLandUrl, loadOrigins } from "@leadwolf/core";
import { sourceFetchRegistryRepository, withPrivilegedTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const LINKEDIN_LINK_FETCH_QUEUE = "linkedin_link_fetch";
const LEADER_KEY = "leader:linkedin_link_fetch";
const LEADER_TTL_MS = 10 * 60_000;
// Persons + companies each get their own bounded slice per tick.
const MAX_PER_KIND_PER_TICK = 25;

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

    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      let landed = 0;
      let skipped = 0;
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
      log.info("linkedin link fetch tick", { landed, skipped });
    });
  };
}
