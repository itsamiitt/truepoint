// forgeSyncRepository.ts — the idempotent, effectively-once apply of ONE Forge master-sync event into the
// master_* graph (docs/planning/forge/11 §3, ADR-0047; G-FORGE-1103/1108). Always called inside withErTx
// (leadwolf_er). Effectively-once: dedup by event_id (processed_sync_events) + a keyed UPSERT — a redelivered
// or reordered push converges to one correct state. The golden entity is LINKed/MINTed via the existing
// co-op-safe resolveForImport; forge_sync then writes the provenance (source_records) + a CONFIRMED match_link,
// because resolution already happened upstream (Forge owns ER). Clear PII never crosses — the payload is match
// keys + blind index only.
//
// Since Phase 1 it ALSO appends field-grain provenance_event rows (08-architecture invariant 1), in the same
// transaction, behind PROVENANCE_EVENTS_ENABLED. This hop is the one place forge data enters the shared graph,
// which is exactly where the assertions belong — and forge.verified_record_events stays separate rather than
// merging, because it is per verified-record VERSION (not per field) and lives behind the schema+role firewall
// that leadwolf_er cannot cross.
import { env } from "@leadwolf/config";
import { DEFAULT_LAWFUL_BASIS, type ProvenanceEventDraft } from "@leadwolf/types";
import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { evidenceRepository } from "./evidenceRepository.ts";
import { masterGraphRepository } from "./masterGraphRepository.ts";

export type SyncApplyOutcome =
  | "applied"
  | "duplicate"
  | "superseded_stale"
  | "suppressed"
  | "rejected";

export interface SyncApplyItem {
  eventId: string;
  eventType: "verified.upserted" | "verified.superseded" | "verified.suppressed";
  version: number;
  contentHash: string; // base64 sha256
  payload: {
    linkedinPublicId?: string;
    emailBlindIndex?: string; // hex HMAC (Forge silver blind index — @leadwolf/identity; decoded hex→bytea below)
    emailDomain?: string;
    registrableDomain?: string;
    companyName?: string;
    entityKind?: "person" | "company";
  };
}

export interface SyncApplyResult {
  outcome: SyncApplyOutcome;
  masterId?: string;
}

export const forgeSyncRepository = {
  /** Apply one verified event effectively-once. MUST run inside withErTx. */
  async applyItem(tx: Tx, item: SyncApplyItem): Promise<SyncApplyResult> {
    // 1. Dedup by event_id (effectively-once) — a conflict means this event already applied.
    const deduped = (await tx.execute(
      sql`INSERT INTO processed_sync_events (event_id, content_hash)
          VALUES (${item.eventId}, decode(${item.contentHash}, 'base64'))
          ON CONFLICT (event_id) DO NOTHING
          RETURNING event_id`,
    )) as unknown as Array<{ event_id: string }>;
    if (deduped.length === 0) return { outcome: "duplicate" };

    // 2. Suppression (DSAR/erasure fan-out, 11 §5) — flip is_suppressed on the matched golden person.
    if (item.eventType === "verified.suppressed") {
      if (item.payload.linkedinPublicId) {
        await tx.execute(
          sql`UPDATE master_persons SET is_suppressed = TRUE
              WHERE linkedin_public_id = ${item.payload.linkedinPublicId}`,
        );
      }
      return { outcome: "suppressed" };
    }

    // 3. LINK/MINT the golden entity via the existing co-op-safe resolver (idempotent on the UNIQUE keys).
    // Forge produces the blind index as canonical HEX (@leadwolf/identity.blindIndexHex) — the hex of the SAME
    // bytes master_emails stores — so decode hex→bytea here to LINK (not mint a duplicate). P-01.6.
    const emailBlindIndex = item.payload.emailBlindIndex
      ? Buffer.from(item.payload.emailBlindIndex, "hex")
      : undefined;
    const resolved = await masterGraphRepository.resolveForImport(tx, {
      linkedinPublicId: item.payload.linkedinPublicId,
      emailBlindIndex,
      emailDomain: item.payload.emailDomain,
      registrableDomain: item.payload.registrableDomain,
      companyName: item.payload.companyName,
    });

    // 4. Provenance: source_records (idempotent on content_hash) + a CONFIRMED match_link (resolution is upstream).
    const src = (await tx.execute(
      sql`INSERT INTO source_records
            (source_name, content_hash, raw_data, match_keys, resolved_person_id, resolved_company_id)
          VALUES ('forge', decode(${item.contentHash}, 'base64'), ${"{}"}::jsonb,
                  ${JSON.stringify(item.payload)}::jsonb,
                  ${resolved.masterPersonId}, ${resolved.masterCompanyId})
          ON CONFLICT (content_hash) DO NOTHING
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;

    const srcId = src[0]?.id;
    if (srcId && resolved.masterPersonId) {
      await tx.execute(
        sql`INSERT INTO match_links (entity_type, cluster_id, source_record_id, match_method, review_status)
            VALUES ('person', ${resolved.masterPersonId}, ${srcId}, 'forge', 'confirmed')`,
      );
    } else if (srcId && resolved.masterCompanyId) {
      await tx.execute(
        sql`INSERT INTO match_links (entity_type, cluster_id, source_record_id, match_method, review_status)
            VALUES ('company', ${resolved.masterCompanyId}, ${srcId}, 'forge', 'confirmed')`,
      );
    }

    // 5. Field-grain assertions (08-architecture invariant 1), in THIS SAME tx — the forge→master hop is the
    // one place forge data enters the shared graph, so it is where the assertions belong. Gated on the env
    // half alone: Layer 0 has no tenant to key a per-tenant flag on, exactly as INGESTION_EVIDENCE_ENABLED
    // already works. Guarded on `srcId`, which is this path's created-check — a redelivered event conflicts on
    // content_hash, returns no id, and must not re-assert (provenance_event is partitioned, so no unique index
    // can catch a double-append and corroboration count is the confidence signal).
    if (env.PROVENANCE_EVENTS_ENABLED && srcId) {
      await evidenceRepository.appendProvenanceEvents(tx, forgeDrafts(item, resolved, srcId));
    }

    return {
      outcome: "applied",
      masterId: resolved.masterPersonId ?? resolved.masterCompanyId ?? undefined,
    };
  },
};

/**
 * What a verified forge event asserts about the golden graph.
 *
 * Built inline rather than through @leadwolf/core's planProvenanceEvents: packages/db cannot import
 * packages/core without creating a dependency cycle (core already imports db). The shared pieces that MUST
 * not drift — the vocabulary and the default lawful basis — live in the leaf @leadwolf/types instead.
 *
 * The payload here is match keys, not a profile, so the assertions are identity-shaped: which public
 * identifier and which domain this verified record vouches for. `emailDomain` and `registrableDomain` are
 * non-PII facets already stored in the clear; the email VALUE never crosses this boundary at all (only its
 * blind index does), so nothing here can smuggle channel PII into the log.
 *
 * `contributorRef` stays null. Forge is platform-side extraction, not a human contribution — attaching a
 * contributor id would put identity on rows nobody vouched for. When forge captures do carry a contributor
 * (raw_captures.captured_by_user_id), threading it is a deliberate later change, not an accident of this one.
 */
function forgeDrafts(
  item: SyncApplyItem,
  resolved: { masterPersonId: string | null; masterCompanyId: string | null },
  sourceRecordId: string,
): ProvenanceEventDraft[] {
  const base = {
    action: "assert",
    sourceType: "forge",
    sourceName: "forge",
    // The upstream ER decided this; 'confirmed' is what the match_link above records, so the method must agree.
    method: "forge",
    contributorRef: null,
    lawfulBasis: DEFAULT_LAWFUL_BASIS,
    confidence: null,
    acceptanceState: "accepted",
    sourceRecordId,
    // Layer 0 has no workspace, and the CHECK in 0089 rejects a scope hint on a Layer-0 row.
    scopeRef: null,
    observedAt: null,
  } as const;

  const drafts: ProvenanceEventDraft[] = [];
  const add = (
    entityType: "person" | "company",
    entityId: string,
    field: string,
    value: string | undefined,
  ) => {
    if (!value) return;
    drafts.push({ ...base, entityType, entityId, field, payload: { v: value } });
  };

  if (resolved.masterPersonId) {
    add("person", resolved.masterPersonId, "linkedinPublicId", item.payload.linkedinPublicId);
    add("person", resolved.masterPersonId, "emailDomain", item.payload.emailDomain);
  }
  if (resolved.masterCompanyId) {
    add("company", resolved.masterCompanyId, "name", item.payload.companyName);
    add("company", resolved.masterCompanyId, "domain", item.payload.registrableDomain);
  }
  return drafts;
}
