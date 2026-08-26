// fetchAndLand.ts — the ONE function the on-view path and the 30-day sweep both call: register a canonical
// LinkedIn URL, fetch its document from the licensed origin fleet (unless fresh), land it, and stamp the
// registry clock (docs/planning ecosystem work). Platform lane — no tenant, no provider_calls ledger (the
// linkedinCompanyRefresh rationale: a platform fetch must not wear a fake workspace id).
//
// FRESHNESS: registerUrl records first-seen without moving the clock; recordFetch is the ONLY writer of
// last_fetched_at, written on every attempt (ok/rejected/unavailable) so a failing URL still rotates off
// the sweep head. A fetch within FRESHNESS_DAYS short-circuits with zero vendor call.
//
// COMPANY DERIVATION (person path): landLinkedinPayload already LINK-or-MINTs a company per position from
// its linkedin_company_id; after a person lands we read those ids back off master_company_identifiers and
// register each as a company target, so the SAME sweep fetches company documents on the same 30-day rule.

import { env } from "@leadwolf/config";
import {
  type Tx,
  masterProfileRepository,
  sourceFetchRegistryRepository,
  withPrivilegedTx,
} from "@leadwolf/db";
import { landLinkedinPayload } from "./landSourcePayload.ts";
import {
  fetchLinkedinCompany,
  fetchLinkedinProfile,
  salesNavCompanyUrl,
} from "./linkedinSourceClient.ts";
import type { LinkedinEntityKind } from "./linkedinUrlKey.ts";

/** The freshness window — a URL fetched within this many days is not re-fetched. */
export const FRESHNESS_DAYS = 30;

export interface FetchAndLandInput {
  entityKind: LinkedinEntityKind;
  normalizedUrl: string;
  externalId?: string | null;
  /** Skip the freshness check (the admin/manual force path). Default false. */
  force?: boolean;
  /** Injectable for tests. */
  fetchProfile?: typeof fetchLinkedinProfile;
  fetchCompany?: typeof fetchLinkedinCompany;
}

export type FetchAndLandOutcome =
  | "fresh" // within the window — no vendor call
  | "landed" // fetched + landed (new or changed)
  | "duplicate" // fetched, byte-identical to what we hold
  | "rejected" // vendor said no (bad/unknown URL)
  | "unavailable"; // origin fleet dark/down — retry appropriate

export interface FetchAndLandResult {
  outcome: FetchAndLandOutcome;
  resolvedPersonId: string | null;
  resolvedCompanyId: string | null;
  /** On `unavailable` from the fleet: the smallest cooldown horizon the walk saw (throttle/outage) —
   *  callers (the sweep) can back off for exactly this long instead of guessing. */
  retryAfterMs?: number;
}

export async function fetchAndLandUrl(input: FetchAndLandInput): Promise<FetchAndLandResult> {
  const fetchProfile = input.fetchProfile ?? fetchLinkedinProfile;
  const fetchCompany = input.fetchCompany ?? fetchLinkedinCompany;

  // Landing dark ⇒ do not spend a vendor call whose document could not land anyway, and do not burn the
  // URL's 30-day clock. Previously the flag was discovered only inside landLinkedinPayload, AFTER the
  // fetch — the call was paid, recordFetch stamped "ok", and the {landed:false, reason:"flag_off"} result
  // was mislabelled "duplicate". Checked here, before the registry is even touched.
  if (!env.LINKEDIN_SOURCE_LANDING_ENABLED) {
    return { outcome: "unavailable", resolvedPersonId: null, resolvedCompanyId: null };
  }

  // Register (first-seen) + read freshness, on the owner connection (the table is app-REVOKEd).
  const reg = await withPrivilegedTx((tx) =>
    sourceFetchRegistryRepository.registerUrl(tx, {
      entityKind: input.entityKind,
      normalizedUrl: input.normalizedUrl,
      externalId: input.externalId ?? null,
    }),
  );
  if (!input.force && isFresh(reg.lastFetchedAt)) {
    return { outcome: "fresh", resolvedPersonId: null, resolvedCompanyId: null };
  }

  // Fetch from the licensed origin fleet — outside any transaction.
  const result =
    input.entityKind === "person"
      ? await fetchProfile(input.normalizedUrl)
      : await fetchCompany(input.normalizedUrl);

  if (result.status !== "ok") {
    const outcome = result.status === "rejected" ? "rejected" : "unavailable";
    await withPrivilegedTx((tx) => sourceFetchRegistryRepository.recordFetch(tx, reg.id, outcome));
    return {
      outcome,
      resolvedPersonId: null,
      resolvedCompanyId: null,
      ...(result.status === "unavailable" && result.retryAfterMs !== undefined
        ? { retryAfterMs: result.retryAfterMs }
        : {}),
    };
  }

  // Land (its own withErTx; idempotent on content hash).
  const landed = await landLinkedinPayload({ payload: result.payload, fetchedAt: new Date() });
  const personId = landed.masterPersonId ?? null;
  const companyId = landed.masterCompanyId ?? null;

  // HONEST OUTCOME. `ok` used to be stamped whatever the landing did, so a payload the parser could not
  // read looked identical in the registry to one that landed cleanly — the whole fleet reported success
  // while storing nothing, and the 30-day clock hid it for a month. A payload we could not parse is a
  // REJECTED fetch: the vendor answered, we cannot use it, and no other origin would answer differently.
  const registryOutcome = landed.reason === "shape_drift" ? "rejected" : "ok";
  if (landed.reason === "shape_drift") {
    console.error("[source-landing] payload did not match any known contract", {
      entityKind: input.entityKind,
      normalizedUrl: input.normalizedUrl,
    });
  }
  await withPrivilegedTx((tx) =>
    sourceFetchRegistryRepository.recordFetch(tx, reg.id, registryOutcome, {
      personId,
      companyId,
    }),
  );

  // Company derivation: for a landed person, register every employer company id as a company target.
  if (input.entityKind === "person" && personId) {
    await registerDerivedCompanies(personId);
  }

  return {
    // "duplicate" means "we already hold this exact document" — it must not double as "we could not read
    // it", which is what made the failure invisible from the caller's side too.
    outcome: landed.landed ? "landed" : landed.reason === "shape_drift" ? "rejected" : "duplicate",
    resolvedPersonId: personId,
    resolvedCompanyId: companyId,
  };
}

function isFresh(lastFetchedAt: Date | null): boolean {
  if (!lastFetchedAt) return false;
  return Date.now() - lastFetchedAt.getTime() < FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
}

/** Read the linkedin_company_id of every company this person is employed at, and register each as a company
 *  fetch target so the sweep collects company documents on the same 30-day rule. */
async function registerDerivedCompanies(masterPersonId: string): Promise<void> {
  const companyIds = await withPrivilegedTx((tx) =>
    listPersonEmployerCompanyIds(tx, masterPersonId),
  );
  for (const linkedinCompanyId of companyIds) {
    await withPrivilegedTx((tx) =>
      sourceFetchRegistryRepository.registerUrl(tx, {
        entityKind: "company",
        normalizedUrl: salesNavCompanyUrl(linkedinCompanyId),
        externalId: linkedinCompanyId,
      }),
    );
  }
}

/** The linkedin_company_id values for a person's employers (via master_employment → the id column /
 *  identifier rows). Owner connection; Layer-0 read. */
async function listPersonEmployerCompanyIds(tx: Tx, masterPersonId: string): Promise<string[]> {
  return masterProfileRepository.listPersonEmployerLinkedinCompanyIds(tx, masterPersonId);
}
