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
}

export async function fetchAndLandUrl(input: FetchAndLandInput): Promise<FetchAndLandResult> {
  const fetchProfile = input.fetchProfile ?? fetchLinkedinProfile;
  const fetchCompany = input.fetchCompany ?? fetchLinkedinCompany;

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
    return { outcome, resolvedPersonId: null, resolvedCompanyId: null };
  }

  // Land (its own withErTx; idempotent on content hash).
  const landed = await landLinkedinPayload({ payload: result.payload, fetchedAt: new Date() });
  const personId = landed.masterPersonId ?? null;
  const companyId = landed.masterCompanyId ?? null;

  await withPrivilegedTx((tx) =>
    sourceFetchRegistryRepository.recordFetch(tx, reg.id, "ok", {
      personId,
      companyId,
    }),
  );

  // Company derivation: for a landed person, register every employer company id as a company target.
  if (input.entityKind === "person" && personId) {
    await registerDerivedCompanies(personId);
  }

  return {
    outcome: landed.landed ? "landed" : "duplicate",
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
