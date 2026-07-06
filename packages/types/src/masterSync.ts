// masterSync.ts — the versioned server-to-server contract for POST /api/v1/master-sync (docs/planning/forge/11,
// ADR-0047). TruePoint Forge (the upstream ER owner) pushes governed verified records here; this is the
// idempotent, effectively-once apply into the master_* graph. The payload carries the resolver MATCH KEYS +
// blind index only — NEVER clear PII (the firewall). This is TruePoint's copy of the Forge @forge/types contract.
import { z } from "zod";

export const masterSyncItem = z.object({
  eventId: z.string().uuid(), // = the effectively-once dedup key (processed_sync_events)
  eventType: z.enum(["verified.upserted", "verified.superseded", "verified.suppressed"]),
  aggregateKind: z.enum([
    "verified_person",
    "verified_company",
    "verified_employment",
    "verified_email",
    "verified_phone",
  ]),
  forgeId: z.string().uuid(),
  version: z.number().int().nonnegative(), // monotonic supersede guard
  contentHash: z.string().min(1), // base64 sha256 → source_records.content_hash (UNIQUE)
  reviewStatus: z.literal("confirmed"), // resolution happened upstream (Forge owns ER)
  // resolver match keys + blind index only — the firewall (no clear PII).
  payload: z
    .object({
      linkedinPublicId: z.string().optional(),
      emailBlindIndex: z.string().optional(), // base64 HMAC
      emailDomain: z.string().optional(),
      registrableDomain: z.string().optional(),
      companyName: z.string().optional(),
      entityKind: z.enum(["person", "company"]).optional(),
    })
    .passthrough(),
});
export type MasterSyncItem = z.infer<typeof masterSyncItem>;

export const masterSyncRequest = z.object({
  syncVersion: z.string().min(1), // SchemaVer; echoes X-Forge-Sync-Version
  batchId: z.string().uuid(),
  emittedAt: z.string().datetime({ offset: true }),
  items: z.array(masterSyncItem).min(1), // NOT all-or-nothing
});
export type MasterSyncRequest = z.infer<typeof masterSyncRequest>;

export const masterSyncItemResult = z.object({
  eventId: z.string().uuid(),
  outcome: z.enum(["applied", "duplicate", "superseded_stale", "suppressed", "rejected"]),
  masterId: z.string().uuid().optional(),
  problem: z.object({ type: z.string(), title: z.string(), detail: z.string() }).optional(),
});
export type MasterSyncItemResult = z.infer<typeof masterSyncItemResult>;

export const masterSyncResponse = z.object({
  syncVersion: z.string().min(1),
  batchId: z.string().uuid(),
  results: z.array(masterSyncItemResult),
});
export type MasterSyncResponse = z.infer<typeof masterSyncResponse>;
