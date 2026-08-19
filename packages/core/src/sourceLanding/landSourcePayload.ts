// landSourcePayload.ts — the Layer-0 landing for a fetched linkedin_api payload: ONE withErTx that turns
// the vendor's document into evidence + resolved identity + provenance-folded facts + edges + series +
// signals (docs/planning/linkedin-source-ingestion/; the forgeSyncRepository.applyItem shape generalized,
// and exactly the producer contract masterEducationRepository.ts:11-19 prescribes).
//
// ORDER INSIDE THE TRANSACTION (each step exists for a reason — do not reorder casually):
//   1. resolveForImport            — LINK-or-MINT the golden identity (mint = identity + dedup keys only).
//   2. appendSourceRecord          — idempotency chokepoint: content_hash UNIQUE; created:false ⇒ STOP.
//                                    A replayed payload writes NOTHING further (no double corroboration,
//                                    no duplicate events — the S-10 badge's signal integrity).
//   3. suppression guard           — an objected person gets the evidence row and NOTHING else. An
//                                    objection means STOP PROCESSING, not just stop revealing; egress
//                                    suppression stays as-is, this is the belt on top.
//   4. linkToCluster               — cluster membership for the evidence row.
//   5. planFieldWrite fold + facts — pins block provider overwrite; only writableFields land; the fold's
//                                    map is stamped back in the same UPDATE.
//   6. edges (employment/education) + identifiers + headcount series.
//   7. appendProvenanceEvents      — from the ACTUAL writableFields (never the incoming set — a pinned
//                                    field was not asserted by this write). D7: an append failure fails
//                                    the WHOLE landing; a fact without its assertion must not survive.
//   8. signals (flag-gated)        — job_change on a primary-employer transition (S-13/S-09), plus
//                                    exec_hired/exec_departed on the same transition when the title infers
//                                    c_suite/vp (leadership family, company-subject); headcount_surge/
//                                    decline past the threshold. Fact + event, the master_company_funding
//                                    precedent.
//
// GATES: LINKEDIN_SOURCE_LANDING_ENABLED gates the whole function (env-only — Layer 0 has no tenant to key
// a flag on); PROVENANCE_EVENTS_ENABLED gates step 7 (the shipped asymmetric posture);
// LINKEDIN_SIGNALS_ENABLED gates step 8. All default-off ⇒ this file is dead code in production today.

import { createHash } from "node:crypto";
import { env } from "@leadwolf/config";
import {
  evidenceRepository,
  masterEducationRepository,
  masterGraphRepository,
  masterIndustryRepository,
  masterProfileRepository,
  masterSignalsRepository,
  withErTx,
} from "@leadwolf/db";
import {
  blindIndex,
  emailDomainOf,
  normalizeEmailForIndex,
  normalizeEmailForStorage,
} from "@leadwolf/identity";
import { linkedinApiCompanyPayloadSchema, linkedinApiPersonPayloadSchema } from "@leadwolf/types";
import { toE164 } from "../enrichment/matchKeys.ts";
import { encryptPii } from "../import/encryptPii.ts";
import { planFieldWrite } from "../prospect/fieldProvenance.ts";
import { acceptanceFor, resolveLawfulBasis } from "../provenance/lawfulBasis.ts";
import { planProvenanceEvents } from "../provenance/planEvents.ts";
import { inferSeniorityFromTitle } from "../search/inferSeniority.ts";
import {
  HEADCOUNT_SIGNAL_MIN_PCT,
  LINKEDIN_API_CONFIDENCE,
  LINKEDIN_API_PROVENANCE_SRC,
  LINKEDIN_API_SOURCE,
  type MappedCompany,
  type MappedPerson,
  headcountDeltaPct,
  mapLinkedinCompany,
  mapLinkedinPerson,
} from "./mapLinkedinPayload.ts";

export interface LandLinkedinPayloadInput {
  /** The verbatim provider payload (person schema_version 1 or company schema_version 2). */
  payload: unknown;
  /** enrichment_policy.lawful_basis when tenant-triggered; null/undefined on the platform sweep lane. */
  workspaceLawfulBasis?: string | null;
  /** When the vendor asserted this document (the fetch time) — observed_at for every fact it lands. */
  fetchedAt: Date;
}

export interface LandLinkedinPayloadResult {
  landed: boolean;
  /** flag_off | shape_drift | duplicate | suppressed | landed */
  reason: "flag_off" | "shape_drift" | "duplicate" | "suppressed" | "landed";
  masterPersonId?: string | null;
  masterCompanyId?: string | null;
}

/** sha256 over the canonical payload, source-prefixed — source_records' idempotency key (the
 *  enrichmentEvidence payloadHash idiom). */
function payloadHash(payload: unknown): Uint8Array {
  return createHash("sha256")
    .update(`provider:${LINKEDIN_API_SOURCE}:`, "utf8")
    .update(JSON.stringify(payload ?? {}), "utf8")
    .digest();
}

export async function landLinkedinPayload(
  input: LandLinkedinPayloadInput,
): Promise<LandLinkedinPayloadResult> {
  if (!env.LINKEDIN_SOURCE_LANDING_ENABLED) return { landed: false, reason: "flag_off" };

  const person = linkedinApiPersonPayloadSchema.safeParse(input.payload);
  if (person.success) {
    return landPerson(mapLinkedinPerson(person.data), input);
  }
  const company = linkedinApiCompanyPayloadSchema.safeParse(input.payload);
  if (company.success) {
    return landCompany(mapLinkedinCompany(company.data), input);
  }
  // Contract drift (schema_version bump or reshaped payload): land nothing structured. The raw payload is
  // already retained by the caller's ledger (provider_calls.response_payload) — the forge SHAPE_DRIFT
  // posture without the quarantine table.
  return { landed: false, reason: "shape_drift" };
}

/** The shared FieldWriteSource for every fold this landing runs. */
function writeSource(fetchedAt: Date) {
  return {
    src: LINKEDIN_API_PROVENANCE_SRC,
    mth: "provider",
    conf: LINKEDIN_API_CONFIDENCE,
    obs: fetchedAt.toISOString(),
    ver: fetchedAt.toISOString(),
  };
}

async function landPerson(
  mapped: MappedPerson,
  input: LandLinkedinPayloadInput,
): Promise<LandLinkedinPayloadResult> {
  const emitEvents = env.PROVENANCE_EVENTS_ENABLED;
  const emitSignals = env.LINKEDIN_SIGNALS_ENABLED;
  const lawfulBasis = resolveLawfulBasis({
    sourceType: "provider",
    workspaceDefault: input.workspaceLawfulBasis ?? null,
  });
  const acceptanceState = acceptanceFor({
    sourceType: "provider",
    workspaceDefault: input.workspaceLawfulBasis ?? null,
  });
  const source = writeSource(input.fetchedAt);

  return withErTx(async (tx) => {
    // 1. Identity. The mint writes slug-only identity (co-op-safe); urn/member id rows land in step 6.
    const resolved = await masterGraphRepository.resolveForImport(tx, {
      linkedinPublicId: mapped.linkedinPublicId,
      linkedinMemberUrn: mapped.linkedinMemberUrn,
      linkedinMemberId: mapped.linkedinMemberId ?? undefined,
    });
    const masterPersonId = resolved.masterPersonId;
    if (!masterPersonId) {
      // Cannot happen for a schema-valid payload (public_identifier is required ⇒ mintable), but stated:
      // no identity, no landing.
      return { landed: false, reason: "shape_drift" as const };
    }

    // 2. Evidence — the idempotency chokepoint.
    const ev = await evidenceRepository.appendSourceRecord(tx, {
      sourceName: LINKEDIN_API_SOURCE,
      contentHash: payloadHash(input.payload),
      rawData: input.payload,
      matchKeys: {
        linkedinPublicId: mapped.linkedinPublicId,
        linkedinMemberUrn: mapped.linkedinMemberUrn,
        linkedinMemberId: mapped.linkedinMemberId,
      },
      resolvedPersonId: masterPersonId,
    });
    if (!ev || !ev.created) {
      return { landed: false, reason: "duplicate" as const, masterPersonId };
    }

    // 3. Suppression guard — evidence only, zero facts, zero signals.
    const personRow = await masterProfileRepository.readPersonForLanding(tx, masterPersonId);
    if (!personRow || personRow.isSuppressed) {
      return { landed: false, reason: "suppressed" as const, masterPersonId };
    }

    // 4. Cluster membership.
    await evidenceRepository.linkToCluster(tx, {
      entityType: "person",
      clusterId: masterPersonId,
      sourceRecordId: ev.id,
    });

    // 5. Profile scalars through the fold — pins block this source, writable fields land, map stamped back.
    const fold = planFieldWrite(
      personRow.fieldProvenance as Parameters<typeof planFieldWrite>[0],
      Object.keys(mapped.fields),
      source,
    );
    const writableValues: Record<string, unknown> = {};
    for (const f of fold.writableFields) writableValues[f] = mapped.fields[f];
    await masterProfileRepository.updatePersonProfile(
      tx,
      masterPersonId,
      writableValues,
      fold.provenance,
    );
    // 5b. Read-side visibility (0121 D2): a person the licensed provider documented is servable to every
    // tenant — the global database search / extension hit / reveal fallback all key off this. One-way, and
    // the predicate re-checks suppression at read time regardless.
    await masterProfileRepository.markPersonLicensed(tx, masterPersonId);

    // 6a. Identifiers (urn / member id / slug rows — the LINK keys for every later refetch).
    await masterProfileRepository.upsertPersonIdentifiers(
      tx,
      masterPersonId,
      mapped.identifiers,
      LINKEDIN_API_SOURCE,
      input.fetchedAt,
    );

    // 6a-ii. Multi-value skills + languages (0116; the C6 gate opened 2026-08-16 by user instruction).
    // Rides the main landing flag — non-channel business-profile attributes, one row per value.
    if (mapped.skills.length > 0) {
      await masterProfileRepository.upsertPersonSkills(
        tx,
        masterPersonId,
        mapped.skills,
        LINKEDIN_API_SOURCE,
        input.fetchedAt,
      );
    }
    if (mapped.languages.length > 0) {
      await masterProfileRepository.upsertPersonLanguages(
        tx,
        masterPersonId,
        mapped.languages,
        LINKEDIN_API_SOURCE,
        input.fetchedAt,
      );
    }

    // 6a-iii. Multi-value TYPED channels (0116) — behind their OWN gate: channel PII is the co-op
    // boundary's sensitive half, and a paid provider's email_enc/phone_enc contribution is a separate
    // decision from profile facts. Normalization here (not the mapper): canonical email / E.164, HMAC
    // blind index, AES-GCM ciphertext. An unparseable value is skipped, never guessed; a value another
    // person already owns is an ER merge signal, never a write.
    if (env.LINKEDIN_CHANNELS_ENABLED) {
      let landedEmail = false;
      for (const e of mapped.emails) {
        const storage = normalizeEmailForStorage(e.value);
        if (!storage) continue;
        const outcome = await masterProfileRepository.upsertPersonEmail(tx, {
          masterPersonId,
          emailEnc: encryptPii(storage),
          emailBlindIndex: blindIndex(normalizeEmailForIndex(storage)),
          emailDomain: emailDomainOf(storage) ?? null,
          emailType: e.type,
          isPrimary: e.isPrimary,
          sourceName: LINKEDIN_API_SOURCE, // 0121 D3 — the reveal fallback serves only licensed channels
        });
        if (outcome === "landed") landedEmail = true;
      }
      let landedPhone = false;
      for (const p of mapped.phones) {
        const e164 = toE164(p.value);
        if (!e164) continue;
        const outcome = await masterProfileRepository.upsertPersonPhone(tx, {
          masterPersonId,
          phoneEnc: encryptPii(e164),
          phoneBlindIndex: blindIndex(e164),
          lineType: p.type,
          sourceName: LINKEDIN_API_SOURCE,
        });
        if (outcome === "landed") landedPhone = true;
      }
      if (landedEmail || landedPhone) {
        await masterProfileRepository.raisePersonChannelFacets(tx, masterPersonId, {
          hasEmail: landedEmail,
          hasPhone: landedPhone,
        });
      }
    }

    // 6b. Employment stints — per-position employer LINK-or-MINT (domainless mint by linkedin company id),
    //     then the stint upsert. The primary transition is resolved AFTER all stints exist.
    const stintIds: Array<string | null> = [];
    const stintCompanyIds: Array<string | null> = [];
    for (const p of mapped.positions) {
      let companyId: string | null = null;
      if (p.linkedinCompanyId) {
        const c = await masterGraphRepository.resolveForImport(tx, {
          linkedinCompanyId: p.linkedinCompanyId,
          companyName: p.companyNameRaw ?? undefined,
        });
        companyId = c.masterCompanyId;
        if (companyId && p.linkedinCompanyId) {
          await masterProfileRepository.upsertCompanyIdentifiers(
            tx,
            companyId,
            [{ idType: "linkedin_company_id", idValue: p.linkedinCompanyId }],
            LINKEDIN_API_SOURCE,
            input.fetchedAt,
          );
        }
      }
      const stintId = await masterProfileRepository.upsertEmploymentStint(tx, {
        masterPersonId,
        masterCompanyId: companyId,
        companyNameRaw: p.companyNameRaw,
        companyNameNormalized: p.companyNameNormalized,
        title: p.title,
        location: p.location,
        description: p.description,
        isCurrent: p.isCurrent,
        startedOn: p.start.isoDate,
        endedOn: p.end.isoDate,
        startPrecision: p.start.precision,
        endPrecision: p.end.precision,
        assertingSource: LINKEDIN_API_SOURCE,
        confidence: LINKEDIN_API_CONFIDENCE,
        observedAt: input.fetchedAt,
      });
      stintIds.push(stintId);
      stintCompanyIds.push(companyId);
    }

    // 6c. Primary transition — demote-then-promote; the OLD primary was read in step 3, BEFORE any write.
    const primaryIdx = mapped.primaryPositionIndex;
    const newPrimaryId = primaryIdx != null ? stintIds[primaryIdx] : null;
    const newPrimaryCompanyId = primaryIdx != null ? (stintCompanyIds[primaryIdx] ?? null) : null;
    const oldPrimary = personRow.primaryEmployment;
    const employerChanged =
      newPrimaryId != null &&
      oldPrimary != null &&
      oldPrimary.id !== newPrimaryId &&
      (oldPrimary.masterCompanyId ?? null) !== newPrimaryCompanyId;
    if (newPrimaryId && oldPrimary?.id !== newPrimaryId) {
      await masterProfileRepository.promotePrimaryEmployment(tx, {
        masterPersonId,
        employmentId: newPrimaryId,
        masterCompanyId: newPrimaryCompanyId,
        demotedEndedOn: primaryIdx != null ? mapped.positions[primaryIdx]?.start.isoDate : null,
      });
    }

    // 6d. Education — school LINK-or-MINT by the legacy school-id namespace, then the stint upsert.
    for (const e of mapped.educations) {
      let schoolId: string | null = null;
      if (e.linkedinSchoolId && e.schoolNameRaw) {
        schoolId = await masterProfileRepository.resolveSchoolByExternalId(tx, {
          linkedinSchoolId: e.linkedinSchoolId,
          schoolName: e.schoolNameRaw,
          sourceName: LINKEDIN_API_SOURCE,
          observedAt: input.fetchedAt,
        });
      }
      await masterEducationRepository.recordEducation(tx, {
        masterPersonId,
        masterCompanyId: schoolId,
        schoolNameRaw: e.schoolNameRaw,
        schoolNameNormalized: e.schoolNameNormalized,
        degree: e.degree,
        fieldsOfStudy: e.fieldsOfStudy,
        startedOn: e.start.isoDate,
        endedOn: e.end.isoDate,
        startPrecision: e.start.precision,
        endPrecision: e.end.precision,
        assertingSource: LINKEDIN_API_SOURCE,
        matchMethod: "deterministic",
        confidence: LINKEDIN_API_CONFIDENCE,
        observedAt: input.fetchedAt,
      });
    }

    // 7. Provenance events — the ACTUAL writable set only (a pinned field was not asserted by this write).
    //    D7: any failure here throws and rolls back the entire landing.
    if (emitEvents && fold.writableFields.size > 0) {
      await evidenceRepository.appendProvenanceEvents(
        tx,
        planProvenanceEvents({
          context: {
            entityType: "person",
            entityId: masterPersonId,
            sourceType: "provider",
            lawfulBasis,
            acceptanceState,
            sourceRecordId: ev.id,
          },
          writableFields: fold.writableFields,
          source,
          values: writableValues,
        }),
      );
    }

    // 8. The job-change signal (S-13/S-09) — only on a REAL employer transition, only when the signal flag
    //    is on. evidenceRef makes the emission idempotent per (evidence, subject, type).
    if (emitSignals && employerChanged) {
      await masterSignalsRepository.recordSignal(tx, {
        subjectType: "person",
        subjectId: masterPersonId,
        typeCode: "job_change",
        observedAt: input.fetchedAt,
        payload: {
          fromCompanyId: oldPrimary?.masterCompanyId ?? null,
          toCompanyId: newPrimaryCompanyId,
        },
        relatedCompanyId: newPrimaryCompanyId,
        confidence: LINKEDIN_API_CONFIDENCE,
        sourceName: LINKEDIN_API_SOURCE,
        evidenceRef: ev.id,
      });

      // Leadership signals (exec_hired / exec_departed) ride the SAME transition guard: a first-observed
      // person never fires them (no old primary ⇒ no change happened in the world, only in our coverage).
      // Subject is the COMPANY — that is the row a watchlist watches. The payload references the person by
      // id only (assertNoContactValues is the contract; the channel tables stay the sole PII path).
      const newTitle = primaryIdx != null ? (mapped.positions[primaryIdx]?.title ?? null) : null;
      const newSeniority = inferSeniorityFromTitle(newTitle);
      if (newPrimaryCompanyId && (newSeniority === "c_suite" || newSeniority === "vp")) {
        await masterSignalsRepository.recordSignal(tx, {
          subjectType: "company",
          subjectId: newPrimaryCompanyId,
          typeCode: "exec_hired",
          observedAt: input.fetchedAt,
          payload: { masterPersonId, seniority: newSeniority, title: newTitle },
          relatedCompanyId: oldPrimary?.masterCompanyId ?? null,
          confidence: LINKEDIN_API_CONFIDENCE,
          sourceName: LINKEDIN_API_SOURCE,
          evidenceRef: ev.id,
        });
      }
      const oldSeniority = inferSeniorityFromTitle(oldPrimary?.title);
      if (oldPrimary?.masterCompanyId && (oldSeniority === "c_suite" || oldSeniority === "vp")) {
        await masterSignalsRepository.recordSignal(tx, {
          subjectType: "company",
          subjectId: oldPrimary.masterCompanyId,
          typeCode: "exec_departed",
          observedAt: input.fetchedAt,
          payload: { masterPersonId, seniority: oldSeniority, title: oldPrimary.title },
          relatedCompanyId: newPrimaryCompanyId,
          confidence: LINKEDIN_API_CONFIDENCE,
          sourceName: LINKEDIN_API_SOURCE,
          evidenceRef: ev.id,
        });
      }
    }

    await evidenceRepository.enqueueProjection(tx, {
      entityType: "person",
      clusterId: masterPersonId,
      reason: "evidence_added",
    });

    return { landed: true, reason: "landed" as const, masterPersonId };
  });
}

async function landCompany(
  mapped: MappedCompany,
  input: LandLinkedinPayloadInput,
): Promise<LandLinkedinPayloadResult> {
  const emitEvents = env.PROVENANCE_EVENTS_ENABLED;
  const emitSignals = env.LINKEDIN_SIGNALS_ENABLED;
  const lawfulBasis = resolveLawfulBasis({
    sourceType: "provider",
    workspaceDefault: input.workspaceLawfulBasis ?? null,
  });
  const acceptanceState = acceptanceFor({
    sourceType: "provider",
    workspaceDefault: input.workspaceLawfulBasis ?? null,
  });
  const source = writeSource(input.fetchedAt);

  return withErTx(async (tx) => {
    // 1. Identity — domain first when the payload carries a website, else the domainless linkedin-id mint.
    const resolved = await masterGraphRepository.resolveForImport(tx, {
      registrableDomain: mapped.registrableDomain ?? undefined,
      companyName: mapped.name,
      linkedinCompanyId: mapped.linkedinCompanyId,
      linkedinCompanySlug: mapped.linkedinCompanySlug ?? undefined,
    });
    const masterCompanyId = resolved.masterCompanyId;
    if (!masterCompanyId) return { landed: false, reason: "shape_drift" as const };

    // 2. Evidence.
    const ev = await evidenceRepository.appendSourceRecord(tx, {
      sourceName: LINKEDIN_API_SOURCE,
      contentHash: payloadHash(input.payload),
      rawData: input.payload,
      matchKeys: {
        linkedinCompanyId: mapped.linkedinCompanyId,
        linkedinCompanySlug: mapped.linkedinCompanySlug,
        registrableDomain: mapped.registrableDomain,
      },
      resolvedCompanyId: masterCompanyId,
    });
    if (!ev || !ev.created) {
      return { landed: false, reason: "duplicate" as const, masterCompanyId };
    }

    await evidenceRepository.linkToCluster(tx, {
      entityType: "company",
      clusterId: masterCompanyId,
      sourceRecordId: ev.id,
    });

    // 3. Dual-write the hot id column on a domain-LINKed row that lacks it.
    const companyRow = await masterProfileRepository.readCompanyForLanding(tx, masterCompanyId);
    if (companyRow && companyRow.linkedinCompanyId == null) {
      await masterProfileRepository.fillCompanyLinkedinId(
        tx,
        masterCompanyId,
        mapped.linkedinCompanyId,
      );
    }

    // 4. Firmographics through the fold.
    const fold = planFieldWrite(
      (companyRow?.fieldProvenance ?? {}) as Parameters<typeof planFieldWrite>[0],
      Object.keys(mapped.fields),
      source,
    );
    const writableValues: Record<string, unknown> = {};
    for (const f of fold.writableFields) writableValues[f] = mapped.fields[f];
    await masterProfileRepository.updateCompanyProfile(
      tx,
      masterCompanyId,
      writableValues,
      fold.provenance,
    );
    // 4a′. Canonical industry node (0128, MI-S3) — a DERIVED column, resolved from the vendor spelling via
    // the alias table, deliberately outside the fold (the current_company_id posture: the fold governs the
    // raw `industry` string; the node is a normalization of whatever won). Unresolved spellings stay NULL —
    // an honest gap curation closes by adding an alias, not a code change.
    const rawIndustry = mapped.fields.industry;
    if (typeof rawIndustry === "string" && rawIndustry) {
      const industryId = await masterIndustryRepository.resolveIdForLabel(tx, rawIndustry);
      if (industryId) await masterIndustryRepository.setCompanyIndustry(tx, masterCompanyId, industryId);
    }

    // 4b. Domain fill for a company minted domainless (from a position's numeric id): the company document
    // carries the website, and accounts are keyed by registrable domain — without this the add-to-workspace
    // materializer could never upsert the employer account. FILL only; a domain another company holds is an
    // ER merge, not a fill (fillCompanyPrimaryDomain refuses).
    if (mapped.registrableDomain) {
      await masterProfileRepository.fillCompanyPrimaryDomain(
        tx,
        masterCompanyId,
        mapped.registrableDomain,
      );
    }

    // 5. Identifiers + HQ + the headcount series.
    await masterProfileRepository.upsertCompanyIdentifiers(
      tx,
      masterCompanyId,
      mapped.identifiers,
      LINKEDIN_API_SOURCE,
      input.fetchedAt,
    );
    if (mapped.hq) {
      await masterProfileRepository.upsertCompanyHq(
        tx,
        masterCompanyId,
        {
          addressLine: mapped.hq.addressLine,
          city: mapped.hq.city,
          region: mapped.hq.region,
          postalCode: mapped.hq.postalCode,
        },
        LINKEDIN_API_SOURCE,
        input.fetchedAt,
      );
    }
    if (mapped.headcount.length > 0) {
      await masterProfileRepository.upsertHeadcountSeries(
        tx,
        masterCompanyId,
        mapped.headcount,
        LINKEDIN_API_SOURCE,
        input.fetchedAt,
      );
    }

    // 6. Events from the actual writable set (D7 — a failure rolls the landing back).
    if (emitEvents && fold.writableFields.size > 0) {
      await evidenceRepository.appendProvenanceEvents(
        tx,
        planProvenanceEvents({
          context: {
            entityType: "company",
            entityId: masterCompanyId,
            sourceType: "provider",
            lawfulBasis,
            acceptanceState,
            sourceRecordId: ev.id,
          },
          writableFields: fold.writableFields,
          source,
          values: writableValues,
        }),
      );
    }

    // 7. The directional headcount signal — thresholded (the samples show endless ±0% months) and
    //    evidence-ref-idempotent. Fact table + dated event, the funding precedent.
    if (emitSignals) {
      const delta = headcountDeltaPct(mapped.headcount);
      if (delta && Math.abs(delta.pct) >= HEADCOUNT_SIGNAL_MIN_PCT) {
        await masterSignalsRepository.recordSignal(tx, {
          subjectType: "company",
          subjectId: masterCompanyId,
          typeCode: delta.pct > 0 ? "headcount_surge" : "headcount_decline",
          observedAt: new Date(`${delta.toMonth}T00:00:00.000Z`),
          payload: {
            fromMonth: delta.fromMonth,
            toMonth: delta.toMonth,
            from: delta.from,
            to: delta.to,
            changePct: Math.round(delta.pct * 1000) / 10,
          },
          confidence: LINKEDIN_API_CONFIDENCE,
          sourceName: LINKEDIN_API_SOURCE,
          evidenceRef: ev.id,
        });
      }
    }

    await evidenceRepository.enqueueProjection(tx, {
      entityType: "company",
      clusterId: masterCompanyId,
      reason: "evidence_added",
    });

    return { landed: true, reason: "landed" as const, masterCompanyId };
  });
}
