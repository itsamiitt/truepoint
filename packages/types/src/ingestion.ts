// ingestion.ts — the UNIFIED INGESTION CONTRACT (prospect-database-platform Phase 03 / I2; audit P05). Every
// prospect/company observation — admin upload, Chrome extension, enrichment provider, CRM sync, web form, rep
// submission — enters through ONE idempotent envelope and is recorded as evidence (source_records) before identity
// resolution. Sources are CONNECTORS implementing this contract (@leadwolf/core registry); adding a source never
// touches the shared pipeline. Shared Zod = the single source of truth for the request/response types.
import { z } from "zod";

/** The closed set of ingestion sources — each is a registered connector. */
export const connectorId = z.enum([
  "admin_upload",
  "chrome_extension",
  "enrichment",
  "crm",
  "web_form",
  "email_signature",
  "partner",
  "marketplace",
  "rep_submission",
  "api",
]);
export type ConnectorId = z.infer<typeof connectorId>;

/** Consent context — REQUIRED for capture sources (chrome_extension / web_form): the lawful basis, the source URL,
 *  and who/when captured (the BrowserGate / ToS posture, Phase 06/09). Absent for server-side sources
 *  (admin_upload / enrichment / crm), which carry their basis elsewhere. */
export const consentContext = z.object({
  basis: z.string().min(1), // legitimate_interest | consent | contract | …
  sourceUrl: z.string().url().optional(),
  capturedByUserId: z.string().uuid().optional(),
  capturedAt: z.string().datetime({ offset: true }).optional(),
});
export type ConsentContext = z.infer<typeof consentContext>;

/** One raw observation as delivered by a connector — the verbatim source payload. Mapped to canonical fields
 *  downstream (the shared pipeline) and kept verbatim for `source_records.raw_data`. */
export const rawObservation = z.record(z.string(), z.unknown());
export type RawObservation = z.infer<typeof rawObservation>;

/** The unified ingestion envelope — ONE idempotent entry for every source. `scope.workspaceId` is optional for
 *  platform-level (tenant-less) sources. `idempotencyKey` dedupes re-delivery (the import_jobs pattern); a
 *  per-record content-hash dedupes an identical re-observation downstream. */
export const ingestionEnvelope = z.object({
  source: connectorId,
  scope: z.object({
    tenantId: z.string().uuid(),
    workspaceId: z.string().uuid().optional(),
  }),
  idempotencyKey: z.string().min(1).max(255),
  collectedAt: z.string().datetime({ offset: true }),
  consent: consentContext.optional(),
  records: z.array(rawObservation).min(1).max(10_000),
});
export type IngestionEnvelope = z.infer<typeof ingestionEnvelope>;

/** The ingestion job lifecycle (mirrors import_jobs). */
export const ingestionJobStatus = z.enum([
  "received",
  "validating",
  "processing",
  "completed",
  "failed",
]);
export type IngestionJobStatus = z.infer<typeof ingestionJobStatus>;
