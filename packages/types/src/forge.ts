// forge.ts — the TruePoint Forge wire vocabulary (ADR-0046; re-homed from @forge/types). Owns envelope v2 (the
// verbatim-payload superset of the existing ingestionEnvelope) + the medallion enums. The master-sync contract
// + access-token/promotion shapes already live in ./masterSync.ts + ./index.ts (added in the receiver + auth
// phases), so they are NOT redefined here. `connectorId`/`consentContext` collide with ./ingestion.ts, so the
// Forge variants are named `forgeConnectorId` / `forgeConsentContext`.
import { z } from "zod";

// ── medallion enums (decision-ledger L2) ──────────────────────────────────────────────────────────────
export const syncState = z.enum(["pending", "synced", "failed", "superseded"]);
export type SyncState = z.infer<typeof syncState>;

export const reviewStatus = z.enum(["auto", "pending", "confirmed", "rejected"]);
export type ReviewStatus = z.infer<typeof reviewStatus>;

export const captureStatus = z.enum(["landed", "parsed", "erased"]);
export type CaptureStatus = z.infer<typeof captureStatus>;

// ── envelope v2 (07 §Envelope v2) ─────────────────────────────────────────────────────────────────────
export const forgeConnectorId = z.enum([
  "chrome_extension",
  "admin_upload",
  "enrichment",
  "provider",
  "web_form",
  "api",
]);
export type ForgeConnectorId = z.infer<typeof forgeConnectorId>;

export const forgeConsentContext = z.object({
  basis: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  capturedByUserId: z.string().uuid().optional(),
  capturedAt: z.string().datetime({ offset: true }).optional(),
});
export type ForgeConsentContext = z.infer<typeof forgeConsentContext>;

export const rawRecordV2 = z.object({
  rawPayload: z.string(),
  endpoint: z.string().min(1).max(255),
  schemaVersion: z.string().min(1).max(50),
  contentType: z.string().max(100).default("application/json"),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  capturedAt: z.string().datetime({ offset: true }),
  byteSize: z.number().int().nonnegative(),
  fields: z.record(z.string(), z.unknown()).optional(),
});
export type RawRecordV2 = z.infer<typeof rawRecordV2>;

export const chunkDescriptor = z.object({
  groupId: z.string().uuid(),
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});
export type ChunkDescriptor = z.infer<typeof chunkDescriptor>;

export const ingestionEnvelopeV2 = z.object({
  envelopeVersion: z.literal("2"),
  source: forgeConnectorId,
  scope: z.object({
    tenantId: z.string().uuid(),
    workspaceId: z.string().uuid().optional(),
  }),
  idempotencyKey: z.string().min(1).max(255),
  collectedAt: z.string().datetime({ offset: true }),
  capturedBy: z.string().uuid().optional(),
  consent: forgeConsentContext.optional(),
  gzip: z.boolean().default(false),
  chunk: chunkDescriptor.optional(),
  size: z.number().int().nonnegative(),
  records: z.array(rawRecordV2).min(1).max(10_000),
});
export type IngestionEnvelopeV2 = z.infer<typeof ingestionEnvelopeV2>;

export const captureAck = z.object({
  batchId: z.string().uuid(),
  accepted: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});
export type CaptureAck = z.infer<typeof captureAck>;

/** The X-Forge-Sync-Version / X-Forge-Envelope-Version header values (L5, 07). */
export const SYNC_CONTRACT_VERSION = "1" as const;
export const ENVELOPE_VERSION = "2" as const;
