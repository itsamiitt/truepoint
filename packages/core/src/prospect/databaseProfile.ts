// databaseProfile.ts — the GLOBAL profile orchestration (search-consolidation stage 3): the full masked
// Layer-0 profile of a person or a company, readable WITHOUT first adding the record to a workspace.
//
// Same two-transaction shape as the two search files, for the same reason (the leadwolf_app REVOKE wall):
//   1. withErTx     — the graph, with the visibility predicate applied inside every read;
//   2. withTenantTx — the RLS-scoped probe that answers ONLY "does the caller's own workspace hold this".
//
// The Layer-0 half runs its collection reads CONCURRENTLY inside one transaction. They are independent
// SELECTs against different tables keyed by the same slug, so awaiting them in sequence would turn one
// drawer open into five serial round-trips for no reason.
import {
  accountRepository,
  contactRepository,
  masterCompanyReadRepository,
  masterPersonReadRepository,
  masterProfileReadRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import {
  type DatabaseCompanyProfile,
  type DatabasePersonProfile,
  MAX_PROFILE_EDUCATION,
  MAX_PROFILE_EMPLOYMENT,
  MAX_PROFILE_HEADCOUNT_POINTS,
  MAX_PROFILE_LANGUAGES,
  MAX_PROFILE_LOCATIONS,
  MAX_PROFILE_SKILLS,
} from "@leadwolf/types";
import { toMaskedDatabasePerson } from "./searchDatabase.ts";
import { toMaskedDatabaseCompany } from "./searchDatabaseCompanies.ts";

export interface DatabaseProfileScope {
  tenantId: string;
  workspaceId: string;
}

/**
 * The masked profile of one Layer-0 person, or null when the slug is absent OR not visible. The caller turns
 * both into the SAME 404 so a private, suppressed or merged person is indistinguishable from one that never
 * existed — otherwise the response shape itself becomes an enumeration oracle.
 */
export async function readDatabasePersonProfile(
  scope: DatabaseProfileScope,
  slugRaw: string,
): Promise<DatabasePersonProfile | null> {
  const slug = slugRaw.trim().toLowerCase();
  if (!slug) return null;

  const graph = await withErTx(async (tx) => {
    const person = await masterPersonReadRepository.readVisiblePerson(tx, { slug });
    if (!person) return null;
    // Independent reads keyed by the same slug — run them together, not in a chain.
    const [employment, education, skills, languages, hasMobile] = await Promise.all([
      masterProfileReadRepository.employmentForSlugTx(tx, slug, MAX_PROFILE_EMPLOYMENT),
      masterProfileReadRepository.educationForSlugTx(tx, slug, MAX_PROFILE_EDUCATION),
      masterProfileReadRepository.skillsForSlugTx(tx, slug, MAX_PROFILE_SKILLS),
      masterProfileReadRepository.languagesForSlugTx(tx, slug, MAX_PROFILE_LANGUAGES),
      masterProfileReadRepository.hasMobileForSlugTx(tx, slug),
    ]);
    return { person, employment, education, skills, languages, hasMobile };
  });
  if (!graph) return null;

  const owned = await withTenantTx(scope, (tx) =>
    contactRepository.findRevealStateBySlugs(tx, scope.workspaceId, [
      graph.person.linkedinPublicId,
    ]),
  );

  return {
    person: toMaskedDatabasePerson(graph.person, owned.get(graph.person.linkedinPublicId) ?? null),
    employment: graph.employment,
    education: graph.education,
    skills: graph.skills,
    languages: graph.languages,
    hasMobile: graph.hasMobile,
  };
}

/** The masked profile of one Layer-0 company, or null when absent OR not visible (same 404 reasoning). */
export async function readDatabaseCompanyProfile(
  scope: DatabaseProfileScope,
  domainRaw: string,
): Promise<DatabaseCompanyProfile | null> {
  const domain = domainRaw.trim().toLowerCase();
  if (!domain) return null;

  const graph = await withErTx(async (tx) => {
    const company = await masterCompanyReadRepository.findByDomainTx(tx, domain);
    if (!company) return null;
    const [locations, headcountSeries] = await Promise.all([
      masterProfileReadRepository.locationsForDomainTx(tx, domain, MAX_PROFILE_LOCATIONS),
      masterProfileReadRepository.headcountForDomainTx(tx, domain, MAX_PROFILE_HEADCOUNT_POINTS),
    ]);
    return { company, locations, headcountSeries };
  });
  if (!graph) return null;

  const owned = await withTenantTx(scope, (tx) =>
    accountRepository.findByDomains(tx, scope.workspaceId, [domain]),
  );

  return {
    company: toMaskedDatabaseCompany(graph.company, owned.get(domain) ?? null),
    locations: graph.locations,
    // Oldest last from the repository (month DESC); the client charts left-to-right, so reverse once here
    // rather than in every consumer.
    headcountSeries: [...graph.headcountSeries].reverse(),
  };
}
