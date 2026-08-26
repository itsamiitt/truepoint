// materializeFromMaster.ts — "Add to workspace": turn a person the PLATFORM DATABASE already holds into a
// workspace contact (Layer-0-as-database plan, slice 3 [C-01][S-09][A-01]).
//
// This is the verb the global database search and the extension's in-database hit both call. It is the one
// path where overlay values come from the LICENSED master record rather than a page or a file:
//   • addressing is URL-shaped only (slug, or any LinkedIn/Sales-Nav URL the server canonicalizes) — a
//     Layer-0 id never crosses the API boundary;
//   • the read applies the visibility predicate INSIDE masterPersonReadRepository, so a private
//     (workspace-minted) or suppressed person is indistinguishable from absent — `not_in_database`;
//   • the write reuses landOverlayPerson: dedup ladder, pin discipline, provenance row, idempotency;
//   • one user gesture per contact (hard constraint 4 — nothing bulk, nothing background).
import { createHash } from "node:crypto";
import {
  type MasterPersonRow,
  accountRepository,
  masterPersonReadRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import { registrableDomain } from "../enrichment/matchKeys.ts";
import { linkedinUrlKey } from "../sourceLanding/linkedinUrlKey.ts";
import {
  type CaptureLandingResult,
  type CaptureScope,
  landOverlayPerson,
} from "./landOverlayPerson.ts";
import { names, splitLocation } from "./personFields.ts";

export type MaterializeBy = { linkedinPublicId: string } | { url: string };

/** Layer-0 channel PRESENCE for the person — booleans only, never a value (reveal-as-save hands these to the
 *  grid so the OTHER channel's reveal stays on offer after one is revealed). */
export interface MasterPresence {
  hasEmail: boolean;
  hasPhone: boolean;
}

/** The landing result plus presence; absent on a `skipped` outcome (there was no person to read). */
export type MaterializeResult = CaptureLandingResult & { presence?: MasterPresence };

/** The public profile URL for a slug — the canonical, customer-facing addressing form. */
function publicProfileUrl(slug: string): string {
  return `https://www.linkedin.com/in/${slug}`;
}

/** Resolve the addressing input to a slug and (for a Sales-Nav lead URL) its canonical URL + lead id. */
function addressOf(
  by: MaterializeBy,
): { slug?: string; leadId?: string; normalizedUrl?: string } | null {
  if ("linkedinPublicId" in by) {
    const slug = by.linkedinPublicId.trim().toLowerCase();
    return slug ? { slug } : null;
  }
  const key = linkedinUrlKey(by.url);
  if (!key || key.entityKind !== "person") return null;
  if (key.normalizedUrl.includes("/in/")) {
    return { slug: key.externalId?.toLowerCase(), normalizedUrl: key.normalizedUrl };
  }
  return { leadId: key.externalId ?? undefined, normalizedUrl: key.normalizedUrl };
}

/**
 * Materialize the database person into the caller's workspace. Idempotent: re-adding an unchanged person
 * reports `known` (the content hash is the person's id + its updatedAt), and a second add of a changed
 * person refreshes the unpinned scalars.
 */
export async function materializeContactFromMaster(
  scope: CaptureScope,
  by: MaterializeBy,
): Promise<MaterializeResult> {
  const address = addressOf(by);
  if (!address || (!address.slug && !address.normalizedUrl)) {
    return { outcome: "skipped", contactId: null, reason: "not_supported" };
  }

  const row: MasterPersonRow | null = await withErTx(async (tx) => {
    if (address.slug)
      return masterPersonReadRepository.readVisiblePerson(tx, { slug: address.slug });
    const personId = await masterPersonReadRepository.resolveRegistryPerson(
      tx,
      address.normalizedUrl as string,
    );
    return personId ? masterPersonReadRepository.readVisiblePerson(tx, { id: personId }) : null;
  });
  if (!row) return { outcome: "skipped", contactId: null, reason: "not_in_database" };

  const contentHash = new Uint8Array(
    createHash("sha256").update(`master:${row.id}:${row.updatedAt.toISOString()}`).digest(),
  );
  const nm = names({
    firstName: row.firstName ?? undefined,
    lastName: row.lastName ?? undefined,
    fullName: row.fullName ?? undefined,
  });
  const loc = splitLocation(row.locationRaw ?? undefined);
  const companyDomain = row.company
    ? (row.company.primaryDomain ??
      (row.company.websiteUrl ? registrableDomain(row.company.websiteUrl) : null))
    : null;

  const landed = await withTenantTx(scope, async (tx) => {
    // The employer becomes (or resolves to) an account when we hold a registrable domain — the same
    // domain-keyed upsert import uses. A domainless employer simply leaves the contact company-less until
    // the company document lands (fillCompanyPrimaryDomain then supplies the key).
    let accountId: string | null = null;
    if (row.company && companyDomain) {
      accountId = await accountRepository.upsertByDomain(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        name: row.company.name,
        domain: companyDomain,
        masterCompanyId: row.company.id,
      });
    }

    return landOverlayPerson(tx, scope, {
      identity: {
        linkedinPublicId: row.linkedinPublicId,
        linkedinUrl: publicProfileUrl(row.linkedinPublicId),
        salesNavLeadId: address.leadId,
        salesNavProfileUrl: address.leadId ? (address.normalizedUrl ?? null) : null,
      },
      scalars: {
        firstName: nm.firstName,
        lastName: nm.lastName,
        jobTitle: row.jobTitle ?? row.headline ?? undefined,
        seniorityLevel: row.seniorityLevel ?? undefined,
        locationCity: row.locationCity ?? loc.city,
        locationCountry: row.locationCountry ?? loc.country,
      },
      masterPersonId: row.id,
      // Presence bits (0139): the same "email on file / phone on file" the database search shows, persisted
      // on the copy so the grid keeps offering the other channel's reveal after one is revealed.
      masterPresence: { hasEmail: row.hasEmail, hasPhone: row.hasPhone },
      accountId,
      // Vendor-neutral provenance by construction: the workspace learns the value came from the TruePoint
      // database, never which upstream source the platform licensed it from.
      source: { src: "master", mth: "database", conf: 0.75, obs: row.updatedAt.toISOString() },
      sourceName: "database",
      sourceFile: publicProfileUrl(row.linkedinPublicId),
      rawData: {
        linkedinPublicId: row.linkedinPublicId,
        fullName: row.fullName,
        jobTitle: row.jobTitle,
        headline: row.headline,
        company: row.company?.name ?? null,
        location: row.locationRaw,
      },
      contentHash,
    });
  });
  // Presence rides along because the overlay copy carries NO channel value until it is revealed, so the
  // workspace projection alone cannot tell the grid that a phone is still there to reveal.
  return { ...landed, presence: { hasEmail: row.hasEmail, hasPhone: row.hasPhone } };
}
