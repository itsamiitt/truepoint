// profileIntel.ts — the ONE read behind the browser extension's Profile Intelligence Panel
// (`POST /api/v1/contacts/lookup/intel`; chrome-extension/14 X06 remainder, doc 08 §3.2).
//
// WHY THIS EXISTS RATHER THAN N CALLS. The panel renders identity + contact state + career history +
// education + skills + the employer's firmographics and 25-month headcount series, for a subject the user
// just opened. Composing that from the five per-contact intelligence routes costs 4–5 round-trips, cannot
// reach the company at all (the extension never sees an accountId — the overlay bridge is server-side), and
// leaves a database-only person with nothing. This composes it once, from the readers that already exist.
//
// IT IS READ-ONLY. It never calls the vendor and never burns the 30-day freshness clock: fetch-on-view lives
// in `/contacts/lookup` and `/ingest/linkedin-links/:kind/fetch`, which the extension already drives on
// every navigation. A miss here is an honest `not_found` that the next sweep/landing fills in.
//
// THE INVARIANTS (identical to the global profile routes it reuses — see profileIntel.ts in @leadwolf/types):
//   • no channel VALUES (presence bits only; owned values are the separate no-charge /revealed read);
//   • no Layer-0 identifier of any kind (people by slug/URL, companies by registrable domain);
//   • no workspace fact beyond the CALLER's own row, produced under RLS in its own transaction;
//   • suppressed / private / merged is indistinguishable from absent — MASTER_*_VISIBLE lives inside every
//     read in the repositories below, so this file cannot forget it.
import {
  type Tx,
  contactRepository,
  intentSignalRepository,
  masterCompanyReadRepository,
  masterPersonReadRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import type { ProfileIntelResponse } from "@leadwolf/types";
import { linkedinUrlKey } from "../sourceLanding/linkedinUrlKey.ts";
import {
  type DatabaseProfileScope,
  readDatabaseCompanyProfile,
  readDatabasePersonProfile,
} from "./databaseProfile.ts";

/** The empty answer, shaped once so every early return agrees on it. */
function empty(
  kind: ProfileIntelResponse["kind"],
  status: ProfileIntelResponse["status"],
): ProfileIntelResponse {
  return {
    kind,
    status,
    contactId: null,
    owned: false,
    person: null,
    contact: null,
    profile: null,
    company: null,
    signals: [],
  };
}

/**
 * The caller's own workspace row for a subject, plus its tenant signals — ONE tenant transaction.
 *
 * Kept as a function rather than inlined because both branches need it (a person resolved from Layer-0 and a
 * person only the workspace holds), and because the RLS-scoped read must stay visibly separate from the
 * Layer-0 reads above it: they run as different database roles for different reasons.
 */
async function readWorkspaceOverlay(
  scope: DatabaseProfileScope,
  keys: { linkedinPublicId?: string; salesNavLeadId?: string; contactId?: string },
): Promise<{
  contact: ProfileIntelResponse["contact"];
  contactId: string | null;
  owned: boolean;
  signals: ProfileIntelResponse["signals"];
}> {
  return withTenantTx(scope, async (tx: Tx) => {
    const id =
      keys.contactId ??
      (
        await contactRepository.findByDedupKeys(tx, scope.workspaceId, {
          linkedinPublicId: keys.linkedinPublicId,
          salesNavLeadId: keys.salesNavLeadId,
        })
      )?.id ??
      null;
    if (!id) return { contact: null, contactId: null, owned: false, signals: [] };

    const [masked] = await contactRepository.listMaskedByIds(tx, [id]);
    // Only `job_change` has a producer today (the S-13 sweep); the rest of the enum has no writer, so this
    // returns the rows that exist rather than a bucket per type — see accountIntelligence.ts's honesty note.
    const signals = await intentSignalRepository.recentForContact(tx, id, 20);
    return {
      contact: masked ?? null,
      contactId: id,
      owned: masked?.isRevealed ?? false,
      signals: signals.map((s) => ({
        signal_type: s.signalType,
        weight: s.weight,
        detected_at: s.detectedAt.toISOString(),
      })),
    };
  });
}

/** The employer/company block for a domain, or null when the database holds no visible company for it. */
async function readCompanyBlock(
  scope: DatabaseProfileScope,
  domain: string | null | undefined,
): Promise<ProfileIntelResponse["company"]> {
  const d = domain?.trim().toLowerCase();
  if (!d) return null;
  return (await readDatabaseCompanyProfile(scope, d)) ?? null;
}

/**
 * Compose the panel's whole answer for one viewed LinkedIn URL.
 *
 * Person ladder (mirrors `/contacts/lookup` minus the vendor rung):
 *   1. Layer-0 by slug — or, for a Sales-Nav lead URL, via the fetch registry's resolved person id, since
 *      those pages carry no public slug;
 *   2. the caller's workspace overlay (which also answers when Layer 0 holds nothing but the workspace
 *      captured the person itself — the panel still renders identity + contact state, just no history);
 *   3. the employer's company block, addressed by the person's registrable company domain.
 *
 * Company ladder: slug → identifier row → domain; Sales-Nav numeric id → fetch registry → domain.
 */
export async function readProfileIntel(
  scope: DatabaseProfileScope,
  url: string,
): Promise<ProfileIntelResponse> {
  const key = linkedinUrlKey(url);
  if (!key) return empty("not_supported", "not_supported");

  if (key.entityKind === "company") {
    // A Sales-Nav company URL is `/sales/company/<numeric id>`, which ALSO contains "/company/" — testing
    // for that substring alone sends the numeric id down the slug branch, where it matches no identifier row
    // and the company silently disappears. The public form is the one WITHOUT the /sales/ prefix.
    const isSlugForm =
      key.normalizedUrl.includes("/company/") && !key.normalizedUrl.includes("/sales/");
    const domain = await withErTx(async (tx: Tx) =>
      isSlugForm && key.externalId
        ? masterCompanyReadRepository.domainForLinkedinSlugTx(tx, key.externalId)
        : masterCompanyReadRepository.domainForRegistryUrlTx(tx, key.normalizedUrl),
    );
    const company = await readCompanyBlock(scope, domain);
    if (!company) return empty("company", "not_found");
    // `inWorkspace` is the company twin of a person's contactId: the caller's own account for this domain,
    // produced under RLS inside readDatabaseCompanyProfile. There is no contactId on a company page.
    return {
      ...empty("company", company.company.inWorkspace ? "found" : "in_database"),
      company,
    };
  }

  const isSlugForm = key.normalizedUrl.includes("/in/");
  const slug = isSlugForm ? key.externalId?.toLowerCase() : undefined;
  const salesNavLeadId = isSlugForm ? undefined : (key.externalId ?? undefined);

  // Sales-Nav lead pages carry no public slug; the registry stamps the person the URL landed as, so the
  // slug (the addressing key everything else here uses) is one hop away.
  const resolvedSlug =
    slug ??
    (await withErTx(async (tx: Tx) => {
      const personId = await masterPersonReadRepository.resolveRegistryPerson(
        tx,
        key.normalizedUrl,
      );
      if (!personId) return null;
      const row = await masterPersonReadRepository.readVisiblePerson(tx, { id: personId });
      return row?.linkedinPublicId ?? null;
    }));

  const profile = resolvedSlug ? await readDatabasePersonProfile(scope, resolvedSlug) : null;

  const overlay = await readWorkspaceOverlay(scope, {
    linkedinPublicId: profile?.person.linkedinPublicId ?? resolvedSlug ?? undefined,
    salesNavLeadId,
    // The Layer-0 read already did the RLS probe; reuse its answer rather than repeating the lookup.
    contactId: profile?.person.inWorkspace?.contactId,
  });

  if (!profile) {
    // No database record. A workspace capture still deserves the panel (identity + contact state come from
    // the overlay row); anything else is an honest miss the next landing fills in.
    if (!overlay.contactId) return empty("person", "not_found");
    return { ...empty("person", "found"), ...overlay };
  }

  const company = await readCompanyBlock(scope, profile.person.companyDomain);

  return {
    kind: "person",
    status: overlay.contactId ? "found" : "in_database",
    contactId: overlay.contactId,
    owned: overlay.owned,
    person: profile.person,
    contact: overlay.contact,
    profile: {
      employment: profile.employment,
      education: profile.education,
      skills: profile.skills,
      languages: profile.languages,
      hasMobile: profile.hasMobile,
    },
    company,
    signals: overlay.signals,
  };
}
