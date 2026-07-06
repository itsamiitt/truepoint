// contactChannels.ts — Zod schemas + inferred types + constants for the multi-value channel layer
// (`contact_emails` / `contact_phones` — import-and-data-model-redesign 05, THE spec; S-CH1). This IS the
// "reveal/channel layer" the field-provenance scalar slice defers email/phone provenance to
// (fieldProvenance.ts CONTACT_PROVENANCE_FIELDS note; DM6 — `contact_emails`/`contact_phones` supersede the
// era's working name `revealed_channels` for the same reserved seam).
//
// INVARIANT CH-INV-1 (05 §3 — the load-bearing contract every consumer of these shapes may rely on): for
// every live contact, the flat contacts columns (`email_enc`/`email_blind_index`/`email_domain`/
// `email_status`; `phone_enc`/`phone_status`/`phone_line_type`) are a byte-exact projection of the single
// live `is_primary` child row per table — or all-NULL (email_status at its 'unverified' default) when no
// live row exists. The blind-index equality is the checkable form. The flat columns are the PERMANENT
// denormalized primary-value cache, rewritten only by the single write path (`applyChannelWrite`, S-CH2)
// in the same withTenantTx as the child-row change; drift is swept by the S-CH5 reconciliation job.
//
// MASKED-UNTIL-REVEAL (05 §5, G16): pre-reveal, the API exposes COUNTS + per-value SUMMARIES
// ({type, status, lineType, isPrimary}) — NEVER values, and never a SECONDARY email's domain (only the
// primary's domain rides maskedContactSchema.emailDomain, unchanged). Secondary values and secondary
// domains are PII-adjacent and stay masked until a reveal claim exists; an `email` claim unmasks ALL live
// email values of that contact (reveal stays contact × reveal_type grained).
//
// STATUS: vocabulary only — S-CH1 ships no reader/writer. Wiring these summaries into
// maskedContactSchema is the read-cutover work (S-C7/S-CH4); the write path is S-CH2's.

import { z } from "zod";
import { emailStatus, phoneLineType, phoneStatus } from "./contacts.ts";

// ── The per-value `type` (usage-context) vocabularies (05 §1.4) ─────────────────────────────────────────
/** Email usage context. RFC 9553 `contexts` + the Merge/Apideck interop core — lossless egress guaranteed. */
export const contactEmailType = z.enum(["work", "personal", "other"]);
export type ContactEmailType = z.infer<typeof contactEmailType>;

/** Phone usage context: the interop core (work|personal|mobile|other) + the sales-intelligence kinds
 *  `direct`/`hq` every SI dataset ships. `type` answers "what is this value FOR"; `line_type` (the
 *  phoneLineType union, contacts.ts) answers "what kind of line is it"; `status` answers "is it any good"
 *  — the three RFC 9553 axes, with `is_primary` as the degenerate two-level `pref`. */
export const contactPhoneType = z.enum(["work", "personal", "mobile", "direct", "hq", "other"]);
export type ContactPhoneType = z.infer<typeof contactPhoneType>;

/** How a phone's line_type was determined (05 §1.3) — the mandatory companion, because offline typing is
 *  inherently ambiguous (`fixed_line_or_mobile`): carrier lookup (authoritative) vs offline heuristic vs
 *  enrichment payload vs declared in the import file. */
export const lineTypeSource = z.enum(["carrier_lookup", "libphonenumber", "provider", "import"]);
export type LineTypeSource = z.infer<typeof lineTypeSource>;

// ── The S-CH2 dual-write per-tenant flag key (05 §Implementation Steps / §Rollout) ──────────────────────
/** Per-tenant half of the channel dual-write DUAL GATE (S-CH2). Effective dual-write = the global
 *  `CHANNEL_DUAL_WRITE` env kill-switch (the name doc 05 pins) AND this flag (seeded off/off in 0059).
 *  Mirrors IMPORT_V2_FLAG_KEY (importV2.ts) — the shared key lives here so api/workers can never drift. */
export const CHANNELS_DUAL_WRITE_FLAG_KEY = "channels_dual_write";

// ── Per-contact cap (05 §Misuse — APP-LAYER, enforced at the API edge; deliberately no DB constraint) ───
/** Max live values per channel per contact (25 emails / 25 phones): generous × any legitimate dataset,
 *  blocks a hostile 10⁶-row fanout on one contact. Import rows exceeding it append up to the cap + warn. */
export const MAX_CHANNEL_VALUES_PER_CONTACT = 25;

// ── Masked per-value summaries (05 §5 — non-PII: types, statuses, flags; NEVER values or domains) ───────
/** One live email value, masked: usage type + verification status + primary flag. No value, no domain. */
export const contactEmailSummarySchema = z.object({
  type: contactEmailType,
  status: emailStatus,
  isPrimary: z.boolean(),
});
export type ContactEmailSummary = z.infer<typeof contactEmailSummarySchema>;

/** One live phone value, masked: usage type + status grade + carrier line type (the TCPA dial-risk badge
 *  for the per-call picker) + primary flag. No value, ever. */
export const contactPhoneSummarySchema = z.object({
  type: contactPhoneType,
  status: phoneStatus.nullable(),
  lineType: phoneLineType.nullable(),
  isPrimary: z.boolean(),
});
export type ContactPhoneSummary = z.infer<typeof contactPhoneSummarySchema>;

/** The masked channel projection a contact read carries once S-C7/S-CH4 wire it into maskedContactSchema
 *  (additive, optional-populated like `dataHealth`/`revealedTypes` — only surfaces that compute it send it):
 *  live-row counts + per-value summaries. `emailDomain`/`emailStatus`/`phoneStatus`/`phoneLineType` on the
 *  masked contact keep meaning THE PRIMARY's facets (CH-INV-1), so no existing consumer changes. */
export const contactChannelSummariesSchema = z.object({
  emailCount: z.number().int().min(0), // live contact_emails rows
  phoneCount: z.number().int().min(0), // live contact_phones rows
  emailSummaries: z.array(contactEmailSummarySchema).optional(),
  phoneSummaries: z.array(contactPhoneSummarySchema).optional(),
});
export type ContactChannelSummaries = z.infer<typeof contactChannelSummariesSchema>;
