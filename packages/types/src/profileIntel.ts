// profileIntel.ts — the contract for the browser extension's Profile Intelligence Panel read
// (`POST /api/v1/contacts/lookup/intel`; chrome-extension/14 X06 remainder). ONE masked aggregate per viewed
// LinkedIn page — person or company — composed from the contracts that already exist:
//   • `maskedDatabasePersonSchema`  (databaseSearch.ts)        — the Layer-0 identity, URL-addressed
//   • `maskedContactSchema`         (contacts.ts)              — the caller's OWN workspace row, when held
//   • `databasePersonProfile`       (databaseProfile.ts)       — employment / education / skills / languages
//   • `databaseCompanyProfile`      (databaseProfile.ts)       — firmographics + locations + headcount series
//
// THE THREE INVARIANTS the composer must keep (they are the same as the global profile routes'):
//   1. NO CHANNEL VALUES. Email/phone values never ride this payload — presence bits only. The owned values
//      are a separate, no-charge read (`GET /contacts/:id/revealed`) the service worker makes in parallel,
//      and reveal stays credit-gated and workspace-scoped.
//   2. NO LAYER-0 IDENTIFIER. People are addressed by slug/URL, companies by registrable domain; numeric
//      LinkedIn ids and master uuids are internal link metadata (linkedin-source-ingestion README §3).
//   3. NO WORKSPACE FACT BEYOND THE CALLER'S OWN ROW. `contact` and `signals` come from the caller's
//      workspace under RLS; nothing about any other workspace is derivable from the response.
//
// This route is READ-ONLY: it never calls the vendor. Fetch-on-view and the 30-day freshness clock belong
// to `/contacts/lookup` + `/ingest/linkedin-links/:kind/fetch`, which the extension already drives.
import { z } from "zod";
import { maskedContactSchema } from "./contacts.ts";
import { databaseCompanyProfile, databasePersonProfile } from "./databaseProfile.ts";
import { maskedDatabasePersonSchema } from "./databaseSearch.ts";

export const profileIntelRequestSchema = z.object({
  /** Any LinkedIn / Sales-Navigator person or company URL; the server canonicalizes (linkedinUrlKey). */
  url: z.string().url().max(2048),
});
export type ProfileIntelRequest = z.infer<typeof profileIntelRequestSchema>;

/** What kind of page the URL addressed. `not_supported` = search/list/messaging/non-LinkedIn. */
export const profileIntelKind = z.enum(["person", "company", "not_supported"]);
export type ProfileIntelKind = z.infer<typeof profileIntelKind>;

/**
 * Mirrors `/contacts/lookup`'s ladder WITHOUT the vendor rung: `found` = the caller's workspace holds the
 * subject (a contact, or an account for a company page); `in_database` = the platform database holds it
 * (Add to workspace materializes it); `not_found` = neither; `not_supported` = not a person/company URL.
 */
export const profileIntelStatus = z.enum(["found", "in_database", "not_found", "not_supported"]);
export type ProfileIntelStatus = z.infer<typeof profileIntelStatus>;

/** A tenant intent signal on the caller's OWN contact (today only `job_change` has a producer). ISO date. */
export const profileIntelSignalSchema = z.object({
  signal_type: z.string(),
  weight: z.number(),
  detected_at: z.string(),
});
export type ProfileIntelSignal = z.infer<typeof profileIntelSignalSchema>;

/** The person's history blocks — the global profile minus its identity (which rides as `person`). */
export const profileIntelPersonBlocksSchema = databasePersonProfile.omit({ person: true });
export type ProfileIntelPersonBlocks = z.infer<typeof profileIntelPersonBlocksSchema>;

export const profileIntelResponseSchema = z.object({
  kind: profileIntelKind,
  status: profileIntelStatus,
  /** The caller's workspace contact id when `found` for a person; null otherwise. */
  contactId: z.string().uuid().nullable(),
  /** The workspace already owns reveal data for this contact (`isRevealed`). */
  owned: z.boolean(),
  /** Layer-0 masked identity (URL-addressed). Null when the database does not hold the person. */
  person: maskedDatabasePersonSchema.nullable(),
  /** The caller's own workspace row (masked: presence bits + statuses + freshness). Null unless `found`. */
  contact: maskedContactSchema.nullable(),
  /** Employment / education / skills / languages / hasMobile. Null when `person` is null. */
  profile: profileIntelPersonBlocksSchema.nullable(),
  /** The current employer (person page) or the company itself (company page), when the database holds it. */
  company: databaseCompanyProfile.nullable(),
  /** Tenant signals for the found contact; [] otherwise. Never an empty bucket per type. */
  signals: z.array(profileIntelSignalSchema),
});
export type ProfileIntelResponse = z.infer<typeof profileIntelResponseSchema>;
