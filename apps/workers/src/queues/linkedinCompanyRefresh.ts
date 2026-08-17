// linkedinCompanyRefresh.ts — the scheduled, leader-locked PLATFORM sweep that keeps tracked companies'
// firmographics + monthly headcount series fresh from the linkedin_api source
// (docs/planning/linkedin-source-ingestion/). Triple-dark: registered only when
// LINKEDIN_COMPANY_REFRESH_ENABLED="true", an EMPTY origin fleet (no provider_origins row + no env fallback) skips every fetch, and the
// landing itself no-ops unless LINKEDIN_SOURCE_LANDING_ENABLED.
//
// This is a LAYER-0 lane — there is no tenant in scope, so spend is NOT ledgered in provider_calls (that
// table is workspace-scoped by design; contorting a platform sweep into a tenant ledger would put a fake
// workspace id on real money). The cost control here is structural instead: MAX_COMPANIES_PER_TICK bounds
// each tick, the enumeration only returns companies still missing THIS month's totals point (so the sweep
// self-terminates each month), and fetches run sequentially under the leader lock — one worker, N≤cap
// calls, every tick. The reverificationSweep pacing posture.
//
// The fetch itself goes through the SAME hardened transport as every enrichment adapter
// (defaultFetchJson: https-only, host allowlist, timeout, size cap, no redirects).

import { env } from "@leadwolf/config";
import {
  fetchLinkedinCompany,
  landLinkedinPayload,
  loadOrigins,
  salesNavCompanyUrl,
} from "@leadwolf/core";
import { masterProfileRepository, withErTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const LINKEDIN_COMPANY_REFRESH_QUEUE = "linkedin_company_refresh";
const LEADER_KEY = "leader:linkedin_company_refresh";
const LEADER_TTL_MS = 10 * 60_000;
// Bounded fan-in per tick: ~25 companies/tick at a 6h cadence ≈ 100/day — deliberate trickle while the
// source proves itself; raising it is a one-constant decision with the spend math in the planning doc.
const MAX_COMPANIES_PER_TICK = 25;

export type LinkedinCompanyRefreshJobData = Record<string, never>;

/** Fetch one company document from the source. Injectable for tests; null = miss/unfetchable (skip). */
export type FetchCompanyPayload = (linkedinCompanyId: string) => Promise<unknown | null>;

export function defaultFetchCompanyPayload(): FetchCompanyPayload {
  return async (linkedinCompanyId) => {
    // The real vendor contract via the origin fleet: POST <origin>/api/linkedin/company with the
    // sales-nav URL built from the stored numeric id. The client walks the failover chain; no registered
    // origin (and no env fallback) ⇒ "unavailable" ⇒ skip — the compliance dark posture at fleet level.
    const result = await fetchLinkedinCompany(salesNavCompanyUrl(linkedinCompanyId));
    return result.status === "ok" ? result.payload : null;
  };
}

export function makeProcessLinkedinCompanyRefresh(
  redis: IORedis,
  fetchCompany: FetchCompanyPayload = defaultFetchCompanyPayload(),
) {
  return async function processLinkedinCompanyRefresh(
    _job: Job<LinkedinCompanyRefreshJobData>,
  ): Promise<void> {
    // Re-check the gates before the lock — an operator flipping the env off must stop the NEXT tick.
    if (!env.LINKEDIN_COMPANY_REFRESH_ENABLED || !env.LINKEDIN_SOURCE_LANDING_ENABLED) return;
    // Fleet configured? Origins come from provider_origins (0117; ≤60s-stale) with the legacy env pair as
    // the zero-row fallback — an empty chain means the source is dark, so skip without burning the census.
    if ((await loadOrigins("linkedin_api")).length === 0) {
      log.info("linkedin company refresh skipped (no active origin)");
      return;
    }
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const due = await withErTx((tx) =>
        masterProfileRepository.listCompaniesForRefresh(tx, MAX_COMPANIES_PER_TICK),
      );
      if (due.length === 0) return;

      let landed = 0;
      let skipped = 0;
      for (const company of due) {
        const payload = await fetchCompany(company.linkedinCompanyId);
        if (payload == null) {
          skipped += 1;
          continue;
        }
        try {
          const result = await landLinkedinPayload({ payload, fetchedAt: new Date() });
          if (result.landed) landed += 1;
          else skipped += 1;
        } catch (e) {
          // D7 posture inside the landing already rolled its tx back; the sweep records and moves on —
          // one company's failure must not starve the rest of the tick.
          skipped += 1;
          log.error("linkedin company refresh: landing failed", {
            masterCompanyId: company.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      log.info("linkedin company refresh tick", { due: due.length, landed, skipped });
    });
  };
}
