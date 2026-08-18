// landCapture.ts — land a chrome_extension capture into the workspace overlay (the missing half of
// POST /api/v1/ingest, docs/planning/extension-intelligence-loop.md slice A). One captured LinkedIn
// profile becomes (or refreshes) ONE overlay contact, with:
//   • the same dedup ladder every landing path uses (findByDedupKeys — the partial ws-unique indexes),
//   • the same field-provenance pin discipline as import/enrichment (planFieldWrite; a user-pinned
//     scalar is never clobbered by a capture),
//   • the same co-op-safe master LINK-or-MINT bridge (resolveForImport under withErTx; non-fatal),
//   • a source_imports provenance row per landing (rule 5: no ingestion path writes without provenance),
//   • content-hash idempotency: an identical re-observation is a no-op that reports the existing contact.
// Deliberately synchronous: a capture is one small row, not a bulk job — the import pipeline stays the
// home of anything batched. The capture's consent context was already validated by the connector.
import { createHash } from "node:crypto";
import {
  contactRepository,
  masterGraphRepository,
  sourceImportRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import type { RawObservation } from "@leadwolf/types";
import { CONTACT_PROVENANCE_FIELDS } from "@leadwolf/types";
import { planFieldWrite } from "../prospect/fieldProvenance.ts";

export type CaptureLandingOutcome = "created" | "updated" | "known" | "skipped";

export interface CaptureLandingResult {
  outcome: CaptureLandingOutcome;
  contactId: string | null;
  /** Why a record was skipped (no dedupable identity key). */
  reason?: string;
}

export interface CaptureScope {
  tenantId: string;
  workspaceId: string;
  capturedByUserId: string | null;
}

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

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Split "City, Country" best-effort; a single token stays city-only (never guess a country). */
function splitLocation(location: string | undefined): { city?: string; country?: string } {
  if (!location) return {};
  const parts = location
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { city: parts.slice(0, -1).join(", "), country: parts.at(-1) };
  return { city: parts[0] };
}

function names(f: CaptureFields): { firstName?: string; lastName?: string } {
  if (f.firstName || f.lastName) return { firstName: f.firstName, lastName: f.lastName };
  if (!f.fullName) return {};
  const parts = f.fullName.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts.at(-1) };
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
  const scalarValues: Record<string, string | undefined> = {
    firstName: nm.firstName,
    lastName: nm.lastName,
    jobTitle: f.jobTitle,
    locationCity: loc.city,
    locationCountry: loc.country,
  };
  const scalarFields = Object.keys(scalarValues).filter(
    (k) =>
      scalarValues[k] !== undefined && (CONTACT_PROVENANCE_FIELDS as readonly string[]).includes(k),
  );

  return withTenantTx(scope, async (tx) => {
    const prior = await sourceImportRepository.findByContentHash(
      tx,
      scope.workspaceId,
      contentHash,
    );
    if (prior?.contactId) return { outcome: "known", contactId: prior.contactId };

    const match = await contactRepository.findByDedupKeys(tx, scope.workspaceId, {
      linkedinPublicId: publicId,
      salesNavLeadId,
    });

    let contactId: string;
    let outcome: CaptureLandingOutcome;
    if (match) {
      // Refresh scalars with the pin discipline: a user-corrected field survives every capture.
      const existingProv = await contactRepository.getFieldProvenance(tx, match.id);
      const planned = planFieldWrite(existingProv, scalarFields, {
        src: "capture:chrome_extension",
      });
      const values: Record<string, unknown> = {
        fieldProvenance: planned.provenance,
        // The identity/linking fields are not pin-gated (same posture as import).
        linkedinPublicId: publicId ?? undefined,
        linkedinUrl: publicId ? (f.profileUrl ?? undefined) : undefined,
        salesNavLeadId: salesNavLeadId ?? undefined,
        salesNavProfileUrl: salesNavLeadId ? (f.profileUrl ?? undefined) : undefined,
        masterPersonId: masterPersonId ?? undefined,
      };
      for (const field of planned.writableFields) values[field] = scalarValues[field];
      await contactRepository.update(
        tx,
        match.id,
        values as Parameters<typeof contactRepository.update>[2],
      );
      contactId = match.id;
      outcome = "updated";
    } else {
      const { provenance } = planFieldWrite({}, scalarFields, {
        src: "capture:chrome_extension",
      });
      contactId = await contactRepository.insert(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        firstName: nm.firstName ?? null,
        lastName: nm.lastName ?? null,
        jobTitle: f.jobTitle ?? null,
        locationCity: loc.city ?? null,
        locationCountry: loc.country ?? null,
        linkedinPublicId: publicId ?? null,
        linkedinUrl: publicId ? (f.profileUrl ?? null) : null,
        salesNavLeadId: salesNavLeadId ?? null,
        salesNavProfileUrl: salesNavLeadId ? (f.profileUrl ?? null) : null,
        masterPersonId: masterPersonId ?? undefined,
        fieldProvenance: provenance,
      });
      outcome = "created";
    }

    await sourceImportRepository.append(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      contactId,
      importedByUserId: scope.capturedByUserId,
      sourceName: "chrome_extension",
      sourceFile: f.sourceUrl ?? null,
      rawData: observation,
      contentHash,
    });

    return { outcome, contactId };
  });
}
