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
// STATUS at S-CH4: the summaries ARE wired into maskedContactSchema (contacts.ts) behind the composed read
// gate. The usage-type enums + masked summary schemas MOVED to contacts.ts at S-CH4 (maskedContactSchema
// embeds them and this file imports contacts.ts — keeping them here would cycle); the @leadwolf/types
// barrel exports are unchanged, so no consumer moved. This file remains the channel layer's home for the
// flag keys, the per-contact cap, and line_type_source.

import { z } from "zod";

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

// ── The S-CH4 read-cutover per-tenant flag key (05 §Implementation Steps / §Rollout) ────────────────────
/** Per-tenant half of the channel READ-CUTOVER gate (S-CH4). Effective read-from-child = the global
 *  `CHANNEL_READ_FROM_CHILD` env kill-switch (the name doc 05's S-CH4 row pins) AND this flag AND the full
 *  S-CH2 dual-write gate — read IMPLIES dual-write (05 §5 ordering; a cutover atop an unmaintained cache is
 *  unsound), fail-closed. Seeded off in 0060. The key lives here so api/workers/db tests can never drift. */
export const CHANNELS_READ_FLAG_KEY = "channels_read";

// ── Per-contact cap (05 §Misuse — APP-LAYER, enforced at the API edge; deliberately no DB constraint) ───
/** Max live values per channel per contact (25 emails / 25 phones): generous × any legitimate dataset,
 *  blocks a hostile 10⁶-row fanout on one contact. Import rows exceeding it append up to the cap + warn. */
export const MAX_CHANNEL_VALUES_PER_CONTACT = 25;
