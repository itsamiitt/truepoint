// enrichmentEvidence.ts — Layer-0 evidence + provenance events for a waterfall-v2 enrichment (0111),
// mirroring recordImportEvidence (runImport.ts) verbatim in posture [A-01, CLAUDE.md rule 5]:
//   • its OWN withErTx (leadwolf_er) — provenance_event and source_records are not writable from the
//     tenant tx, and the overlay landing must not hold the ER role's transaction;
//   • called only past the INGESTION_EVIDENCE_ENABLED gate (the call site checks it — same as import);
//   • events inner-gated on PROVENANCE_EVENTS_ENABLED and appended ONLY past appendSourceRecord's
//     `created` guard (idempotency: provenance_event is partitioned and has no unique to lean on; a
//     replayed payload must not double every corroboration count — the S-10 badge's signal);
//   • FAILURE POSTURE (import D7): events-flag ON → the error propagates and fails the job attempt
//     (a retry is spend-safe — tx2's cache rows already committed); OFF → log-and-continue.
//
// EVENT SCOPE: person-level events for the won CONTACT_PROVENANCE_FIELDS scalars only, values included
// (`{v}` payloads). email/phone events are DELIBERATELY not emitted here — the import pipeline sets the
// precedent (importProvenanceDrafts emits only the scalar set), and channel-level events belong to the
// channel provenance slice. One source_records row per WINNING provider, each with its own raw payload.

import { createHash } from "node:crypto";
import { env } from "@leadwolf/config";
import { evidenceRepository, withErTx } from "@leadwolf/db";
import { CONTACT_PROVENANCE_FIELDS, type EnrichField } from "@leadwolf/types";
import { acceptanceFor, resolveLawfulBasis } from "../provenance/lawfulBasis.ts";
import { planProvenanceEvents } from "../provenance/planEvents.ts";
import type { FieldWin } from "./fieldWaterfall.ts";

export interface RecordEnrichmentEvidenceInput {
  masterPersonId: string;
  winners: ReadonlyMap<EnrichField, FieldWin>;
  rawPayloadByProvider: ReadonlyMap<string, unknown>;
  /** The contact's email domain — the match key the evidence row carries (never the address itself). */
  emailDomain?: string;
  /** enrichment_policy.lawful_basis (0091) — resolveLawfulBasis's workspaceDefault input. */
  workspaceLawfulBasis: string | null;
}

/** sha256 over the provider payload — source_records' content-hash idempotency key. */
function payloadHash(provider: string, payload: unknown): Uint8Array {
  return createHash("sha256")
    .update(`provider:${provider}:`, "utf8")
    .update(JSON.stringify(payload ?? {}), "utf8")
    .digest();
}

export async function recordEnrichmentEvidence(
  input: RecordEnrichmentEvidenceInput,
): Promise<void> {
  const emitEvents = env.PROVENANCE_EVENTS_ENABLED;

  // Group won fields by their winning provider — one evidence row + one event batch per provider.
  const byProvider = new Map<string, { fields: EnrichField[]; values: Record<string, unknown> }>();
  for (const [field, win] of input.winners) {
    const group = byProvider.get(win.provider) ?? { fields: [], values: {} };
    group.fields.push(field);
    group.values[field] = win.value;
    byProvider.set(win.provider, group);
  }

  const lawfulBasis = resolveLawfulBasis({
    sourceType: "provider",
    workspaceDefault: input.workspaceLawfulBasis,
  });
  const acceptanceState = acceptanceFor({
    sourceType: "provider",
    workspaceDefault: input.workspaceLawfulBasis,
  });

  try {
    await withErTx(async (tx) => {
      for (const [provider, group] of byProvider) {
        const payload = input.rawPayloadByProvider.get(provider) ?? {};
        const ev = await evidenceRepository.appendSourceRecord(tx, {
          sourceName: provider,
          contentHash: payloadHash(provider, payload),
          rawData: payload as Record<string, unknown>,
          matchKeys: { emailDomain: input.emailDomain },
          resolvedPersonId: input.masterPersonId,
        });
        if (!ev || !ev.created) continue; // idempotent replay — don't double-link, don't double-assert

        await evidenceRepository.linkToCluster(tx, {
          entityType: "person",
          clusterId: input.masterPersonId,
          sourceRecordId: ev.id,
        });
        await evidenceRepository.enqueueProjection(tx, {
          entityType: "person",
          clusterId: input.masterPersonId,
          reason: "evidence_added",
        });

        if (emitEvents) {
          const scalarFields = group.fields.filter((f) =>
            (CONTACT_PROVENANCE_FIELDS as readonly string[]).includes(f),
          );
          if (scalarFields.length === 0) continue;
          await evidenceRepository.appendProvenanceEvents(
            tx,
            planProvenanceEvents({
              context: {
                entityType: "person",
                entityId: input.masterPersonId,
                sourceType: "provider",
                lawfulBasis,
                acceptanceState,
                sourceRecordId: ev.id,
              },
              writableFields: scalarFields,
              source: { src: `provider:${provider}`, mth: "deterministic" },
              values: group.values,
            }),
          );
        }
      }
    });
  } catch (err) {
    // Import D7 posture: with provenance events ON, an evidence failure fails the run rather than being
    // swallowed — silently landing a value whose assertion was lost is what makes invariant 1 aspirational.
    if (emitEvents) throw err;
    console.error("[enrichment] evidence dual-write failed (non-fatal; flag-gated)", err);
  }
}
