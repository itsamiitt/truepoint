// forgeSyncRepository.ts — the idempotent, effectively-once apply of ONE Forge master-sync event into the
// master_* graph (docs/planning/forge/11 §3, ADR-0047; G-FORGE-1103/1108). Always called inside withErTx
// (leadwolf_er). Effectively-once: dedup by event_id (processed_sync_events) + a keyed UPSERT — a redelivered
// or reordered push converges to one correct state. The golden entity is LINKed/MINTed via the existing
// co-op-safe resolveForImport; forge_sync then writes the provenance (source_records) + a CONFIRMED match_link,
// because resolution already happened upstream (Forge owns ER). Clear PII never crosses — the payload is match
// keys + blind index only.
import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
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
    emailBlindIndex?: string; // base64 HMAC
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
    const emailBlindIndex = item.payload.emailBlindIndex
      ? Buffer.from(item.payload.emailBlindIndex, "base64")
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

    return {
      outcome: "applied",
      masterId: resolved.masterPersonId ?? resolved.masterCompanyId ?? undefined,
    };
  },
};
