// landOverlayPerson.ts — the ONE overlay person-landing body, shared by every path that turns an external
// person into a workspace contact (the extension capture, the "Add to workspace" database materialization).
// Runs inside the CALLER's tenant tx (RLS), and always does the same four things:
//   1. content-hash idempotency — an identical re-observation reports the prior contact, writes nothing;
//   2. the dedup ladder (findByDedupKeys: email → linkedin → sales-nav partial ws-uniques);
//   3. the field-provenance pin discipline (planFieldWrite — a user-corrected scalar is sacrosanct);
//   4. one source_imports provenance row per landing (rule 5: no ingestion path writes without provenance).
// Identity/link columns are deliberately NOT pin-gated (same posture as import): they address the record,
// they are not a human's judgement about it.
import type { Tx } from "@leadwolf/db";
import { contactRepository, sourceImportRepository } from "@leadwolf/db";
import type { SourceName } from "@leadwolf/types";
import { CONTACT_PROVENANCE_FIELDS } from "@leadwolf/types";
import { type FieldWriteSource, planFieldWrite } from "../prospect/fieldProvenance.ts";

export type CaptureLandingOutcome = "created" | "updated" | "known" | "skipped";

export interface CaptureLandingResult {
  outcome: CaptureLandingOutcome;
  contactId: string | null;
  /** Why a record was skipped (no identity key / no person data / not in the database). */
  reason?: string;
}

export interface CaptureScope {
  tenantId: string;
  workspaceId: string;
  capturedByUserId: string | null;
}

/** The scalar profile fields an overlay landing may write (the pin-protected subset). */
export type OverlayScalars = Partial<
  Record<
    | "firstName"
    | "lastName"
    | "jobTitle"
    | "seniorityLevel"
    | "department"
    | "locationCity"
    | "locationCountry",
    string | undefined
  >
>;

export interface OverlayPersonLanding {
  identity: {
    linkedinPublicId?: string;
    salesNavLeadId?: string;
    linkedinUrl?: string | null;
    salesNavProfileUrl?: string | null;
  };
  scalars: OverlayScalars;
  masterPersonId: string | null;
  accountId?: string | null;
  source: FieldWriteSource;
  sourceName: SourceName;
  sourceFile: string | null;
  rawData: Record<string, unknown>;
  contentHash: Uint8Array;
  /** Refuse to CREATE a contact carrying no name AND no title — the junk-capture guard. An UPDATE of an
   *  existing contact is unaffected (a thin re-observation of a known person is still useful). */
  requireCreateData?: boolean;
}

export async function landOverlayPerson(
  tx: Tx,
  scope: CaptureScope,
  input: OverlayPersonLanding,
): Promise<CaptureLandingResult> {
  const prior = await sourceImportRepository.findByContentHash(
    tx,
    scope.workspaceId,
    input.contentHash,
  );
  if (prior?.contactId) return { outcome: "known", contactId: prior.contactId };

  const match = await contactRepository.findByDedupKeys(tx, scope.workspaceId, {
    linkedinPublicId: input.identity.linkedinPublicId,
    salesNavLeadId: input.identity.salesNavLeadId,
  });

  const { firstName, lastName, jobTitle } = input.scalars;
  if (!match && input.requireCreateData && !firstName && !lastName && !jobTitle) {
    return { outcome: "skipped", contactId: null, reason: "no_person_data" };
  }

  const scalarFields = Object.keys(input.scalars).filter(
    (k) =>
      input.scalars[k as keyof OverlayScalars] !== undefined &&
      (CONTACT_PROVENANCE_FIELDS as readonly string[]).includes(k),
  );

  let contactId: string;
  let outcome: CaptureLandingOutcome;
  if (match) {
    const existingProv = await contactRepository.getFieldProvenance(tx, match.id);
    const planned = planFieldWrite(existingProv, scalarFields, input.source);
    const values: Record<string, unknown> = {
      fieldProvenance: planned.provenance,
      linkedinPublicId: input.identity.linkedinPublicId ?? undefined,
      linkedinUrl: input.identity.linkedinUrl ?? undefined,
      salesNavLeadId: input.identity.salesNavLeadId ?? undefined,
      salesNavProfileUrl: input.identity.salesNavProfileUrl ?? undefined,
      masterPersonId: input.masterPersonId ?? undefined,
      accountId: input.accountId ?? undefined,
    };
    for (const field of planned.writableFields) {
      values[field] = input.scalars[field as keyof OverlayScalars];
    }
    await contactRepository.update(
      tx,
      match.id,
      values as Parameters<typeof contactRepository.update>[2],
    );
    contactId = match.id;
    outcome = "updated";
  } else {
    const { provenance } = planFieldWrite({}, scalarFields, input.source);
    contactId = await contactRepository.insert(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      jobTitle: jobTitle ?? null,
      seniorityLevel: input.scalars.seniorityLevel ?? null,
      department: input.scalars.department ?? null,
      locationCity: input.scalars.locationCity ?? null,
      locationCountry: input.scalars.locationCountry ?? null,
      linkedinPublicId: input.identity.linkedinPublicId ?? null,
      linkedinUrl: input.identity.linkedinUrl ?? null,
      salesNavLeadId: input.identity.salesNavLeadId ?? null,
      salesNavProfileUrl: input.identity.salesNavProfileUrl ?? null,
      masterPersonId: input.masterPersonId ?? undefined,
      accountId: input.accountId ?? null,
      fieldProvenance: provenance,
    });
    outcome = "created";
  }

  await sourceImportRepository.append(tx, {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    contactId,
    importedByUserId: scope.capturedByUserId,
    sourceName: input.sourceName,
    sourceFile: input.sourceFile,
    rawData: input.rawData,
    contentHash: input.contentHash,
  });

  return { outcome, contactId };
}
