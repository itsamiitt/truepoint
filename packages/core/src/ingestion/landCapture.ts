// landCapture.ts — land a chrome_extension capture into the workspace overlay (the missing half of
// POST /api/v1/ingest, docs/planning/extension-intelligence-loop.md slice A). One captured LinkedIn
// profile becomes (or refreshes) ONE overlay contact. The landing BODY is landOverlayPerson (shared with
// the database materializer); this module only parses the observation, resolves the Layer-0 bridge, and
// applies the capture-specific posture:
//   • requireCreateData — a capture that read no name AND no title creates nothing (the junk-row guard);
//   • the co-op-safe master LINK-or-MINT bridge (resolveForImport under withErTx; non-fatal).
// Deliberately synchronous: a capture is one small row, not a bulk job. The capture's consent context was
// already validated by the connector.
import { createHash } from "node:crypto";
import { masterGraphRepository, withErTx, withTenantTx } from "@leadwolf/db";
import type { RawObservation } from "@leadwolf/types";
import {
  type CaptureLandingResult,
  type CaptureScope,
  landOverlayPerson,
} from "./landOverlayPerson.ts";
import { names, splitLocation, str } from "./personFields.ts";

export type {
  CaptureLandingOutcome,
  CaptureLandingResult,
  CaptureScope,
} from "./landOverlayPerson.ts";

/** The subset of a capture observation this landing reads. Everything else rides along in raw_data. */
interface CaptureFields {
  publicId?: string;
  salesNavLeadId?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  company?: string;
  location?: string;
  profileUrl?: string;
  sourceUrl?: string;
}

/**
 * Land one capture observation. Returns the landed contact id and what happened. Never throws for a
 * per-record data problem (reports `skipped` instead); infrastructure errors propagate to the route.
 */
export async function landCapturedObservation(
  scope: CaptureScope,
  observation: RawObservation,
): Promise<CaptureLandingResult> {
  const f: CaptureFields = {
    publicId: str(observation.publicId),
    salesNavLeadId: str(observation.salesNavLeadId),
    fullName: str(observation.fullName),
    firstName: str(observation.firstName),
    lastName: str(observation.lastName),
    jobTitle: str(observation.jobTitle),
    company: str(observation.company),
    location: str(observation.location),
    profileUrl: str(observation.profileUrl),
    sourceUrl: str(observation.sourceUrl),
  };

  // The LinkedIn slug (lowercased — the canonical linkedinPublicIdOf form, so lookup and write agree) is
  // the primary dedup key; a Sales-Nav lead id is the fallback for /sales/lead pages, which expose no slug.
  // No email ever leaves the page.
  const publicId = f.publicId?.toLowerCase();
  const salesNavLeadId = f.salesNavLeadId;
  if (!publicId && !salesNavLeadId) {
    return { outcome: "skipped", contactId: null, reason: "no_identity_key" };
  }

  // Content-hash idempotency (the source_imports partial ws-unique): an identical re-observation of the
  // same profile short-circuits to the previously landed contact — a duplicate drain is a true no-op.
  const contentHash = new Uint8Array(
    createHash("sha256")
      .update(JSON.stringify({ publicId, salesNavLeadId, ...f }))
      .digest(),
  );

  // Master LINK-or-MINT in its OWN tx under leadwolf_er (never inside the tenant tx; non-fatal — a
  // resolution failure lands the row with a null bridge, backfilled later by the sweep). A sales-nav-only
  // capture has no mintable key (the resolver's keyless guard) — it lands with a null bridge by design.
  let masterPersonId: string | null = null;
  if (publicId) {
    try {
      const resolved = await withErTx((tx) =>
        masterGraphRepository.resolveForImport(tx, {
          linkedinPublicId: publicId,
          companyName: f.company,
        }),
      );
      masterPersonId = resolved.masterPersonId;
    } catch (err) {
      console.error("[capture] master resolution failed; landing with null bridge", err);
    }
  }

  const loc = splitLocation(f.location);
  const nm = names(f);

  return withTenantTx(scope, (tx) =>
    landOverlayPerson(tx, scope, {
      identity: {
        linkedinPublicId: publicId,
        salesNavLeadId,
        linkedinUrl: publicId ? (f.profileUrl ?? null) : null,
        salesNavProfileUrl: salesNavLeadId ? (f.profileUrl ?? null) : null,
      },
      scalars: {
        firstName: nm.firstName,
        lastName: nm.lastName,
        jobTitle: f.jobTitle,
        locationCity: loc.city,
        locationCountry: loc.country,
      },
      masterPersonId,
      source: { src: "capture:chrome_extension" },
      sourceName: "chrome_extension",
      sourceFile: f.sourceUrl ?? null,
      rawData: observation,
      contentHash,
      // A capture that read nothing usable (the pre-guard Sales-Nav failure mode) must not mint a blank
      // contact; refreshing an EXISTING one from a thin observation is still fine.
      requireCreateData: true,
    }),
  );
}
