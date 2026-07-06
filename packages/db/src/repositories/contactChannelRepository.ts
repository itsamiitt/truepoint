// contactChannelRepository.ts — the ONE sanctioned write path for the multi-value channel child tables
// (`contact_emails` / `contact_phones`) AND the flat primary-value cache they project into
// (import-and-data-model-redesign 05 §3.1, invariant CH-INV-1; S-CH2). Every op runs child-row change +
// flat-cache projection in the CALLER's withTenantTx — never two transactions, never fire-and-forget.
// Callers (import merge, enrichment, reveal verify, re-verification — later: user edit, merge executor)
// compose ops; they never touch the child tables or the flat channel columns directly once dual-write is on.
//
// PHASE (S-CH2, dual-write): the FLAT columns are still the source of truth. Callers pass the EXACT bytes
// they wrote (or will hold) flat — ciphertext + blind index computed once by packages/core's DM1 primitives
// (`prepareContact` / the channel-value builders) — so the primary child row is a byte-exact projection by
// construction (CH-INV-1's checkable form: blind-index equality; phone value_enc ciphertext bytes shared
// verbatim with contacts.phone_enc). This layer takes bytes only: no crypto, no normalizers here (DM1 keeps
// those in core); RLS on the caller's tx is the isolation wall (schema/contactChannels.ts, FORCE RLS).
//
// PRIMARY DESIGNATION (05 §3.3/§6, the pure rules in contactChannelPlan.ts): first live value for a channel
// becomes primary (+ flat projection is REWRITTEN from the op's bytes — structural, not hoped-for); an
// existing live primary is NEVER flipped by an upsert; per-contact dedup on blind_index keeps first_seen_at;
// per-contact cap (25) skips + reports, never errors. Ws-unique email collisions (a value live on ANOTHER
// contact) are handled as 05 §2.2 mandates: batch-check first, ON CONFLICT DO NOTHING as the race backstop,
// the outcome reported as `collision` for the caller to count — never surfaced as a row error. Phones are
// deliberately NOT ws-unique (shared HQ/switchboard lines are legal); the cross-contact E.164 duplicate
// SIGNAL (the review-queue rung) is S-C6's, not written here.
//
// S-CH3 (backfill, 15 §2.1): the repo family also carries the backfill's WHERE-missing keyset selection, the
// dedicated verbatim-bytes projection insert (`backfillContactChannels` — sanctioned by 15 §2; see its
// comment for why applyChannelWrite's shape must not be reused there), and the owner-conn census +
// completeness count (the S-CH4 gate). None of these run on live traffic; the sweep worker is the only caller.
//
// S-CH4 (read cutover, 05 §5/§6): the repo family also carries the READ side — the batched masked channel
// summaries for list surfaces (one IN-list query per table for N contacts, no N+1; counts + type/status/
// lineType/isPrimary ONLY — never a value, never a domain), the primary-first full value lists for
// reveal/export (encrypted bytes out; core decrypts, ownership-gated), and the workspace-scoped email
// blind-index probe the dedup ladder's email rung retargets to (contact_emails.blind_index — the §2.2
// ws-unique guarantees ≤1 live row per key). Every read method is LIVE-rows-only (`deleted_at IS NULL`) and
// runs under the caller's RLS tx; callers invoke them ONLY when the composed S-CH4 read gate (core's
// isChannelReadFromChildEnabled: CHANNEL_READ_FROM_CHILD env + `channels_read` flag, implying the S-CH2
// dual gate) evaluated ON — gate-off performs zero child-table reads by construction.
//
// STATUS MIRROR (flat wins while S-CH2/S-CH3 are the world, 05 §3.4): on primary designation the child row's
// status columns are stamped FROM the contact's flat status columns (email_status / phone_status /
// phone_line_type) so CH-INV-1 holds including statuses at write time; the verify ops keep them in step
// afterwards. Residual drift (e.g. the shipped writers not resetting flat status on a value change) is the
// S-CH5 sweep's flat-wins repair case.

import {
  type ContactChannelSummaries,
  type ContactEmailSummary,
  type ContactPhoneSummary,
  MAX_CHANNEL_VALUES_PER_CONTACT,
} from "@leadwolf/types";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "../client.ts";
import { contactEmails, contactPhones } from "../schema/contactChannels.ts";
import { contacts } from "../schema/contacts.ts";
import { planChannelUpsert } from "./contactChannelPlan.ts";

/** Tenancy stamp for new child rows (denormalized NOT NULL on every row — DM4). RLS on the caller's tx is
 *  the wall; these are the column values, never a trust boundary. */
export interface ChannelWriteScope {
  tenantId: string;
  workspaceId: string;
}

/** One email value, as BYTES (computed by core's DM1 primitives; MUST be the same bytes the caller wrote
 *  flat, so the primary projection is byte-exact — CH-INV-1). */
export interface EmailChannelValue {
  valueEnc: Uint8Array; // ciphertext of the storage form == contacts.email_enc bytes
  blindIndex: Uint8Array; // HMAC of the index form == contacts.email_blind_index bytes
  emailDomain: string; // clear non-PII facet (emailDomainOf)
  type?: string; // usage context (05 §1.4); default 'other'
  source: string; // field_provenance.src grammar: import:<src> | provider:<p> | user_edit | reveal | master
  sourceImportId?: string | null;
}

/** One phone value, as BYTES + derived E.164 material (built by core's buildPhoneChannelValue). */
export interface PhoneChannelValue {
  valueEnc: Uint8Array; // ciphertext of the cleaned as-entered value == contacts.phone_enc bytes
  blindIndex: Uint8Array; // HMAC of the digit-compacted raw (works even when E.164 parsing fails)
  e164Enc?: Uint8Array | null; // NULL exactly when unparseable (05 §4 — kept raw, flagged, never rejected)
  e164BlindIndex?: Uint8Array | null;
  rawOriginalEnc?: Uint8Array | null; // byte-exact original WHEN it differs from the cleaned form
  countryHint?: string | null; // ISO-3166 alpha-2 actually used at parse time (re-parse reproducibility)
  extension?: string | null;
  lineType?: string | null;
  lineTypeSource?: string | null;
  type?: string;
  source: string;
  sourceImportId?: string | null;
}

/** The ops S-CH2's writers compose. Add/promote/delete user verbs land with doc 04's channel API (S-CH4). */
export type ChannelWriteOp =
  | { kind: "email_upsert"; contactId: string; value: EmailChannelValue }
  | { kind: "phone_upsert"; contactId: string; value: PhoneChannelValue }
  /** Mirror a verification grade onto the LIVE PRIMARY child row (reveal / re-verification — the callers
   *  that just wrote the same grade to the flat status columns). No-op when no live primary exists yet
   *  (pre-backfill contacts) — S-CH3 closes that tail. */
  | { kind: "email_verify"; contactId: string; status: string; lastVerifiedAt: Date }
  | {
      kind: "phone_verify";
      contactId: string;
      status?: string | null;
      lineType?: string | null;
      lineTypeSource?: string | null;
      lastVerifiedAt: Date;
    };

export type ChannelWriteOutcome =
  /** A new row was inserted. `becamePrimary` ⇒ the flat cache was re-projected from this value. */
  | { result: "inserted"; rowId: string; becamePrimary: boolean }
  /** The value already lived on the contact. `promoted` ⇒ it filled a primary vacuum (+ projection). */
  | { result: "existing"; rowId: string; promoted: boolean }
  /** Email only: the value is live on ANOTHER contact in the workspace (ws-unique identity, 05 §2.2) —
   *  skipped, for the caller to count/signal; never an error. */
  | { result: "collision" }
  /** New value but the contact is at the per-contact cap — skipped + counted (05 §Misuse). */
  | { result: "capped" }
  /** A verify op found + updated the live primary row. */
  | { result: "verified"; rowId: string }
  /** A verify op found no live primary row (pre-backfill) — nothing to mirror. */
  | { result: "noop" };

// ── S-CH3 backfill family (15 §2.1 — the executable contract) ───────────────────────────────────────────
// The backfill's selection predicate IS its watermark: a contact is "missing" per channel when it holds the
// flat key and NO live child row of that channel exists — so any batch is re-runnable, a crash resumes by
// re-selecting, and a done contact is never touched again (idempotent no-op by construction; no stored
// cursor table needed). The predicate is 15 §2.1's completeness query verbatim (email leg keys on
// email_blind_index; phone leg on phone_enc), shared by the in-tx batch selection, the owner-conn census,
// and the S-CH4 gate count — one predicate, three readers, so the gate can never disagree with the walker.

/** One selected contact of the WHERE-missing keyset walk (flat bytes travel VERBATIM; the worker decrypts
 *  ONLY the phone — email ciphertext is never decrypted, CH-INV-1's byte-projection guarantee). */
export interface MissingChannelProjectionRow {
  id: string;
  /** Flat email key present AND no live contact_emails row. */
  needsEmail: boolean;
  /** Flat phone present AND no live contact_phones row. */
  needsPhone: boolean;
  emailEnc: Uint8Array | null;
  emailBlindIndex: Uint8Array | null;
  emailDomain: string | null;
  emailStatus: string;
  phoneEnc: Uint8Array | null;
  phoneStatus: string | null;
  phoneLineType: string | null;
  locationCountry: string | null;
}

/** The email child payload the backfill inserts — flat bytes VERBATIM (no re-encrypt, no re-normalize). */
export interface BackfillEmailChild {
  valueEnc: Uint8Array;
  blindIndex: Uint8Array;
  emailDomain: string;
  status: string; // mirrored from contacts.email_status (flat wins during S-CH2/S-CH3)
}

/** The phone child payload — value_enc = flat bytes VERBATIM; E.164 material derived in-worker (core). */
export interface BackfillPhoneChild {
  valueEnc: Uint8Array;
  blindIndex: Uint8Array;
  e164Enc: Uint8Array | null; // NULL exactly when unparseable (kept raw + flagged, never skipped)
  e164BlindIndex: Uint8Array | null;
  countryHint: string | null;
  status: string | null; // mirrored from contacts.phone_status
  lineType: string | null; // mirrored from contacts.phone_line_type (05 §Edge: out-of-union → 'unknown')
  lineTypeSource: string | null;
}

// ── S-CH4 read family (05 §5/§6 — the cutover's read shapes) ────────────────────────────────────────────

/** One live email value for reveal/export reads — ENCRYPTED bytes out (core decrypts, ownership-gated).
 *  Primary-first ordering is the repo's contract (05 §5: dial/export/sync pick primary-first). */
export interface LiveEmailChannelRow {
  id: string;
  contactId: string;
  valueEnc: Uint8Array;
  type: string;
  status: string;
  isPrimary: boolean;
}

/** One live phone value for reveal/export reads — encrypted bytes out; primary-first. */
export interface LivePhoneChannelRow {
  id: string;
  contactId: string;
  valueEnc: Uint8Array;
  type: string;
  status: string | null;
  lineType: string | null;
  extension: string | null;
  isPrimary: boolean;
}

/** A live-child email blind-index hit — the S-CH4 dedup email rung's row shape (05 §6). */
export interface EmailBlindIndexHit {
  contactId: string;
  blindIndex: Uint8Array;
}

/** Primary-first, stable within: primary row first (≤1 live primary by the partial unique), then oldest
 *  first_seen_at, then id — deterministic for exports and the per-call phone picker. */
const emailReadOrder = [
  desc(contactEmails.isPrimary),
  asc(contactEmails.firstSeenAt),
  asc(contactEmails.id),
];
const phoneReadOrder = [
  desc(contactPhones.isPrimary),
  asc(contactPhones.firstSeenAt),
  asc(contactPhones.id),
];

export interface BackfillContactChannelsResult {
  emailInserted: boolean;
  phoneInserted: boolean;
  /** Payloads that hit ON CONFLICT DO NOTHING — a concurrent S-CH2 write won the partial unique (race
   *  backstop, 15 §2.1); counted, never an error. */
  conflicts: number;
}

// The per-channel "no live child row" legs, shared verbatim between the tx selection and the owner reads.
const noLiveEmailChild = sql`NOT EXISTS (SELECT 1 FROM ${contactEmails} WHERE ${contactEmails.contactId} = ${contacts.id} AND ${contactEmails.deletedAt} IS NULL)`;
const noLivePhoneChild = sql`NOT EXISTS (SELECT 1 FROM ${contactPhones} WHERE ${contactPhones.contactId} = ${contacts.id} AND ${contactPhones.deletedAt} IS NULL)`;
const emailMissing = sql`(${contacts.emailBlindIndex} IS NOT NULL AND ${noLiveEmailChild})`;
const phoneMissing = sql`(${contacts.phoneEnc} IS NOT NULL AND ${noLivePhoneChild})`;

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.from(a).equals(Buffer.from(b));

interface LiveRow {
  id: string;
  blindIndex: Uint8Array;
  isPrimary: boolean;
}

async function emailUpsert(
  tx: Tx,
  scope: ChannelWriteScope,
  contactId: string,
  value: EmailChannelValue,
): Promise<ChannelWriteOutcome> {
  // Live rows for this contact (bounded by the cap ≈ 25; index-backed under the RLS workspace predicate).
  const live: LiveRow[] = await tx
    .select({
      id: contactEmails.id,
      blindIndex: contactEmails.blindIndex,
      isPrimary: contactEmails.isPrimary,
    })
    .from(contactEmails)
    .where(and(eq(contactEmails.contactId, contactId), isNull(contactEmails.deletedAt)));

  const match = live.find((r) => bytesEqual(r.blindIndex, value.blindIndex));
  const verdict = planChannelUpsert({
    liveCount: live.length,
    matchExists: match !== undefined,
    matchIsPrimary: match?.isPrimary ?? false,
    hasLivePrimary: live.some((r) => r.isPrimary),
    cap: MAX_CHANNEL_VALUES_PER_CONTACT,
  });

  if (verdict === "keep_existing") {
    // Dual-write byte-refresh (CH-INV-1): a dedup hit on the PRIMARY row means the caller just re-wrote
    // the same value flat — with fresh AES-GCM bytes (random IV) and possibly a different storage form
    // (plus-tag variants share an index). The primary projection must track the flat bytes exactly, so
    // refresh value_enc; SECONDARIES keep their first-seen bytes (05 §Edge — flat doesn't hold them).
    if (match!.isPrimary) {
      await tx
        .update(contactEmails)
        .set({ valueEnc: value.valueEnc, updatedAt: new Date() })
        .where(eq(contactEmails.id, match!.id));
    }
    return { result: "existing", rowId: match!.id, promoted: false };
  }
  if (verdict === "capped") return { result: "capped" };

  if (verdict === "promote_existing") {
    await tx
      .update(contactEmails)
      .set({ isPrimary: true, valueEnc: value.valueEnc, updatedAt: new Date() })
      .where(eq(contactEmails.id, match!.id));
    await projectEmailToFlat(tx, contactId, value);
    return { result: "existing", rowId: match!.id, promoted: true };
  }

  // NEW value — ws-unique pre-check (05 §2.2 collision policy): the same email VALUE live on another contact
  // is an identity-key hit that the dedup ladder should have resolved; reaching here means the row matched
  // via another key (or the other contact is soft-archived with live child rows). Skip + report — the
  // partial unique is the race backstop, never the control flow, and never a user-facing error.
  const wsHit = await tx
    .select({ id: contactEmails.id, contactId: contactEmails.contactId })
    .from(contactEmails)
    .where(
      and(
        eq(contactEmails.workspaceId, scope.workspaceId),
        eq(contactEmails.blindIndex, value.blindIndex),
        isNull(contactEmails.deletedAt),
      ),
    )
    .limit(1);
  if (wsHit[0] && wsHit[0].contactId !== contactId) return { result: "collision" };

  const becamePrimary = verdict === "insert_primary";
  const inserted = await tx
    .insert(contactEmails)
    .values({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      contactId,
      valueEnc: value.valueEnc,
      blindIndex: value.blindIndex,
      emailDomain: value.emailDomain,
      type: value.type ?? "other",
      isPrimary: becamePrimary,
      // Primary designation mirrors the flat grade (flat wins during S-CH2); a secondary starts at the
      // per-value default ('unverified') until a verification grades it.
      ...(becamePrimary ? { status: await flatEmailStatus(tx, contactId) } : {}),
      source: value.source,
      sourceImportId: value.sourceImportId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: contactEmails.id });

  if (!inserted[0]) {
    // Race backstop: a concurrent tx won one of the partial uniques. Re-read per-contact; a hit there is a
    // dedup match (treat as existing), otherwise the value landed on another contact — a collision.
    const again = await tx
      .select({ id: contactEmails.id })
      .from(contactEmails)
      .where(
        and(
          eq(contactEmails.contactId, contactId),
          eq(contactEmails.blindIndex, value.blindIndex),
          isNull(contactEmails.deletedAt),
        ),
      )
      .limit(1);
    if (again[0]) return { result: "existing", rowId: again[0].id, promoted: false };
    return { result: "collision" };
  }

  if (becamePrimary) await projectEmailToFlat(tx, contactId, value);
  return { result: "inserted", rowId: inserted[0].id, becamePrimary };
}

async function phoneUpsert(
  tx: Tx,
  scope: ChannelWriteScope,
  contactId: string,
  value: PhoneChannelValue,
): Promise<ChannelWriteOutcome> {
  const live: LiveRow[] = await tx
    .select({
      id: contactPhones.id,
      blindIndex: contactPhones.blindIndex,
      isPrimary: contactPhones.isPrimary,
    })
    .from(contactPhones)
    .where(and(eq(contactPhones.contactId, contactId), isNull(contactPhones.deletedAt)));

  const match = live.find((r) => bytesEqual(r.blindIndex, value.blindIndex));
  const verdict = planChannelUpsert({
    liveCount: live.length,
    matchExists: match !== undefined,
    matchIsPrimary: match?.isPrimary ?? false,
    hasLivePrimary: live.some((r) => r.isPrimary),
    cap: MAX_CHANNEL_VALUES_PER_CONTACT,
  });

  if (verdict === "keep_existing") {
    // Dual-write byte-refresh on a PRIMARY dedup hit (see the email twin): value_enc tracks the flat
    // bytes; the derived E.164 material upgrades ONLY when the op carries it (05 §4 — a later write that
    // parsed successfully upgrades the row in place; a hint-less unparseable retry never downgrades it).
    if (match!.isPrimary) {
      await tx
        .update(contactPhones)
        .set({
          valueEnc: value.valueEnc,
          ...(value.e164Enc && value.e164BlindIndex
            ? {
                e164Enc: value.e164Enc,
                e164BlindIndex: value.e164BlindIndex,
                countryHint: value.countryHint ?? null,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(contactPhones.id, match!.id));
    }
    return { result: "existing", rowId: match!.id, promoted: false };
  }
  if (verdict === "capped") return { result: "capped" };

  if (verdict === "promote_existing") {
    await tx
      .update(contactPhones)
      .set({ isPrimary: true, valueEnc: value.valueEnc, updatedAt: new Date() })
      .where(eq(contactPhones.id, match!.id));
    await projectPhoneToFlat(tx, contactId, value);
    return { result: "existing", rowId: match!.id, promoted: true };
  }

  // Phones are per-contact unique ONLY (05 §2.2 deliberate asymmetry — shared HQ lines are legal): no
  // workspace pre-check, no collision outcome. ON CONFLICT still backstops a same-contact race.
  const becamePrimary = verdict === "insert_primary";
  const flat = becamePrimary ? await flatPhoneGrades(tx, contactId) : null;
  // Primary designation mirrors the flat grades (flat wins during S-CH2). A mirrored line_type came from
  // the phone verifier (the only shipped flat line_type writer) ⇒ carrier_lookup.
  const lineType = value.lineType ?? flat?.phoneLineType ?? null;
  let lineTypeSource = value.lineTypeSource ?? null;
  if (!value.lineType && flat?.phoneLineType) lineTypeSource = "carrier_lookup";
  const inserted = await tx
    .insert(contactPhones)
    .values({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      contactId,
      valueEnc: value.valueEnc,
      blindIndex: value.blindIndex,
      e164Enc: value.e164Enc ?? null,
      e164BlindIndex: value.e164BlindIndex ?? null,
      rawOriginalEnc: value.rawOriginalEnc ?? null,
      countryHint: value.countryHint ?? null,
      extension: value.extension ?? null,
      lineType,
      lineTypeSource,
      type: value.type ?? "other",
      isPrimary: becamePrimary,
      ...(becamePrimary ? { status: flat?.phoneStatus ?? null } : {}),
      source: value.source,
      sourceImportId: value.sourceImportId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: contactPhones.id });

  if (!inserted[0]) {
    const again = await tx
      .select({ id: contactPhones.id })
      .from(contactPhones)
      .where(
        and(
          eq(contactPhones.contactId, contactId),
          eq(contactPhones.blindIndex, value.blindIndex),
          isNull(contactPhones.deletedAt),
        ),
      )
      .limit(1);
    if (again[0]) return { result: "existing", rowId: again[0].id, promoted: false };
    // Unreachable for phones absent a same-contact race (no ws-unique); report as existing-less noop-ish
    // collision so callers never throw on it.
    return { result: "collision" };
  }

  if (becamePrimary) await projectPhoneToFlat(tx, contactId, value);
  return { result: "inserted", rowId: inserted[0].id, becamePrimary };
}

/** Flat-cache projection (CH-INV-1's write half): the flat email columns are REWRITTEN from the newly
 *  designated primary's bytes. During S-CH2 the caller has already written these exact bytes flat in the
 *  same tx — this update is byte-identical and makes the invariant structural rather than coincidental. */
async function projectEmailToFlat(
  tx: Tx,
  contactId: string,
  value: EmailChannelValue,
): Promise<void> {
  await tx
    .update(contacts)
    .set({
      emailEnc: value.valueEnc,
      emailBlindIndex: value.blindIndex,
      emailDomain: value.emailDomain,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}

async function projectPhoneToFlat(
  tx: Tx,
  contactId: string,
  value: PhoneChannelValue,
): Promise<void> {
  await tx
    .update(contacts)
    .set({ phoneEnc: value.valueEnc, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}

/** The contact's flat email grade — mirrored onto a newly designated primary (flat wins during S-CH2). */
async function flatEmailStatus(tx: Tx, contactId: string): Promise<string> {
  const rows = await tx
    .select({ emailStatus: contacts.emailStatus })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  return rows[0]?.emailStatus ?? "unverified";
}

async function flatPhoneGrades(
  tx: Tx,
  contactId: string,
): Promise<{ phoneStatus: string | null; phoneLineType: string | null }> {
  const rows = await tx
    .select({ phoneStatus: contacts.phoneStatus, phoneLineType: contacts.phoneLineType })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  return {
    phoneStatus: rows[0]?.phoneStatus ?? null,
    phoneLineType: rows[0]?.phoneLineType ?? null,
  };
}

export const contactChannelRepository = {
  /**
   * THE single sanctioned channel write (05 §3.1). Composes inside the CALLER's withTenantTx — the child-row
   * change and any flat-cache projection commit or roll back with the caller's own flat write (CH-INV-1:
   * same tx, never two). Gate discipline: callers invoke this ONLY when the S-CH2 dual gate
   * (CHANNEL_DUAL_WRITE env + `channels_dual_write` per-tenant flag) evaluated ON — gate-off performs zero
   * child-table work by construction. Outcomes are data, never throws (a skipped/capped/collided value must
   * never fail the caller's row); a genuine DB error propagates and aborts the caller's tx — dual-write is
   * atomic with the flat write by design.
   */
  async applyChannelWrite(
    tx: Tx,
    scope: ChannelWriteScope,
    op: ChannelWriteOp,
  ): Promise<ChannelWriteOutcome> {
    switch (op.kind) {
      case "email_upsert":
        return emailUpsert(tx, scope, op.contactId, op.value);
      case "phone_upsert":
        return phoneUpsert(tx, scope, op.contactId, op.value);
      case "email_verify": {
        const rows = await tx
          .update(contactEmails)
          .set({
            status: op.status,
            lastVerifiedAt: op.lastVerifiedAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(contactEmails.contactId, op.contactId),
              eq(contactEmails.isPrimary, true),
              isNull(contactEmails.deletedAt),
            ),
          )
          .returning({ id: contactEmails.id });
        return rows[0] ? { result: "verified", rowId: rows[0].id } : { result: "noop" };
      }
      case "phone_verify": {
        const rows = await tx
          .update(contactPhones)
          .set({
            ...(op.status !== undefined ? { status: op.status } : {}),
            ...(op.lineType != null
              ? { lineType: op.lineType, lineTypeSource: op.lineTypeSource ?? null }
              : {}),
            lastVerifiedAt: op.lastVerifiedAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(contactPhones.contactId, op.contactId),
              eq(contactPhones.isPrimary, true),
              isNull(contactPhones.deletedAt),
            ),
          )
          .returning({ id: contactPhones.id });
        return rows[0] ? { result: "verified", rowId: rows[0].id } : { result: "noop" };
      }
    }
  },

  /**
   * S-CH3 batch selection (15 §2.1): keyset walk (id ASC, `cursor` = last id of the previous batch; null =
   * start) over LIVE contacts still missing a child projection on at least one channel. RLS scopes it to ONE
   * workspace via the caller's withTenantTx GUC (no explicit workspace predicate — isolation rides the tx,
   * the findStaleRevealedForReverify precedent; the NOT EXISTS legs run under the same GUC). Returns the
   * encrypted flat bytes: email travels verbatim (never decrypted); the worker decrypts ONLY the phone to
   * derive its blind index + E.164 material (plaintext never leaves the worker).
   */
  async findContactsMissingChannelProjection(
    tx: Tx,
    cursor: string | null,
    limit: number,
  ): Promise<MissingChannelProjectionRow[]> {
    const rows = await tx
      .select({
        id: contacts.id,
        needsEmail: sql<boolean>`${emailMissing}`,
        needsPhone: sql<boolean>`${phoneMissing}`,
        emailEnc: contacts.emailEnc,
        emailBlindIndex: contacts.emailBlindIndex,
        emailDomain: contacts.emailDomain,
        emailStatus: contacts.emailStatus,
        phoneEnc: contacts.phoneEnc,
        phoneStatus: contacts.phoneStatus,
        phoneLineType: contacts.phoneLineType,
        locationCountry: contacts.locationCountry,
      })
      .from(contacts)
      .where(
        and(
          isNull(contacts.deletedAt),
          sql`(${emailMissing} OR ${phoneMissing})`,
          cursor === null ? undefined : gt(contacts.id, cursor),
        ),
      )
      .orderBy(asc(contacts.id))
      .limit(limit);
    return rows.map((r) => ({
      ...r,
      emailEnc: r.emailEnc ?? null,
      emailBlindIndex: r.emailBlindIndex ?? null,
      emailDomain: r.emailDomain ?? null,
      phoneEnc: r.phoneEnc ?? null,
      phoneStatus: r.phoneStatus ?? null,
      phoneLineType: r.phoneLineType ?? null,
      locationCountry: r.locationCountry ?? null,
    }));
  },

  /**
   * S-CH3's dedicated write entry — the 15 §2 sanctioned sibling of `applyChannelWrite`, NOT a second write
   * path for live traffic: it exists because the backfill's shape is the one applyChannelWrite must never
   * have — it NEVER touches the flat cache (flat is the source being projected FROM; rewriting it would
   * churn every contact's updated_at fleet-wide) and it must be a strict no-op on re-runs (applyChannelWrite's
   * primary byte-refresh would rewrite updated_at on every pass). Inserts the `is_primary=true` projection
   * row per channel WHERE the upstream selection said none exists; `ON CONFLICT DO NOTHING` on the 05 §2.2
   * partial uniques is the race backstop against a concurrent S-CH2 dual-write (its row wins; ours is
   * counted as a conflict, never an error — the contact ends correctly projected either way). Existing child
   * rows are never read, never updated, never demoted. Runs inside the caller's withTenantTx batch tx: a
   * genuine DB error aborts the WHOLE batch, so a contact's email+phone projections commit together or not
   * at all (no-partial-visibility, 15 §2.1).
   */
  async backfillContactChannels(
    tx: Tx,
    scope: ChannelWriteScope,
    contactId: string,
    plan: { email?: BackfillEmailChild; phone?: BackfillPhoneChild },
  ): Promise<BackfillContactChannelsResult> {
    let emailInserted = false;
    let phoneInserted = false;
    let conflicts = 0;
    if (plan.email) {
      const rows = await tx
        .insert(contactEmails)
        .values({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          contactId,
          valueEnc: plan.email.valueEnc, // flat ciphertext VERBATIM — CH-INV-1 by construction
          blindIndex: plan.email.blindIndex, // flat blind index VERBATIM
          emailDomain: plan.email.emailDomain,
          type: "other", // usage context unknowable for pre-channel values — the 05 §1.4 default, honest
          isPrimary: true,
          status: plan.email.status, // status mirror (flat wins during S-CH2/S-CH3)
          source: "backfill", // provenance label: the S-CH3 projection pass, not a data origin claim
          sourceImportId: null, // lineage unknowable at backfill grain (the flat slot kept no pointer)
        })
        .onConflictDoNothing()
        .returning({ id: contactEmails.id });
      if (rows[0]) emailInserted = true;
      else conflicts += 1;
    }
    if (plan.phone) {
      const rows = await tx
        .insert(contactPhones)
        .values({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          contactId,
          valueEnc: plan.phone.valueEnc, // flat ciphertext VERBATIM (raw original IS the flat value)
          blindIndex: plan.phone.blindIndex,
          e164Enc: plan.phone.e164Enc, // NULL exactly when unparseable — kept raw, flagged, never skipped
          e164BlindIndex: plan.phone.e164BlindIndex,
          rawOriginalEnc: null, // value_enc IS the flat original; stored only when it differs (05 §1.3)
          countryHint: plan.phone.countryHint,
          extension: null,
          lineType: plan.phone.lineType,
          lineTypeSource: plan.phone.lineTypeSource,
          type: "other",
          isPrimary: true,
          status: plan.phone.status,
          source: "backfill",
          sourceImportId: null,
        })
        .onConflictDoNothing()
        .returning({ id: contactPhones.id });
      if (rows[0]) phoneInserted = true;
      else conflicts += 1;
    }
    return { emailInserted, phoneInserted, conflicts };
  },

  /**
   * SYSTEM-LEVEL census for the leader-locked backfill sweep: the (tenantId, workspaceId) of every workspace
   * still holding contacts missing a channel projection. OWNER connection (no leadwolf_app drop — the set is
   * intentionally cross-workspace; mirrors listWorkspacesWithUnresolvedContacts); returns ONLY non-PII ids;
   * NOT reachable from a tenant request — only the sweep worker calls it. `limit`-capped fan-out.
   */
  async listWorkspacesMissingChannelProjection(
    limit = 1000,
  ): Promise<Array<{ tenantId: string; workspaceId: string }>> {
    const rows = (await db.execute(
      sql`SELECT DISTINCT tenant_id, workspace_id FROM contacts c
          WHERE c.deleted_at IS NULL
            AND ((c.email_blind_index IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM contact_emails ce WHERE ce.contact_id = c.id AND ce.deleted_at IS NULL))
              OR (c.phone_enc IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM contact_phones cp WHERE cp.contact_id = c.id AND cp.deleted_at IS NULL)))
          LIMIT ${limit}`,
    )) as unknown as Array<{ tenant_id: string; workspace_id: string }>;
    return rows.map((r) => ({ tenantId: r.tenant_id, workspaceId: r.workspace_id }));
  },

  /**
   * THE S-CH4 GATE (15 §2.1's verification query, verbatim predicate): live contacts with a flat channel
   * value and no live child row of that channel. **S-CH4 does not flip until this reads 0** after the
   * post-dual-write re-run (and the S-CH5 drift metric reads 0 — S-CH5's own row). Owner connection —
   * fleet-wide, non-PII count; also the sweep's `backfill_remaining` gauge.
   */
  async countContactsMissingChannelProjection(): Promise<number> {
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM contacts c
          WHERE c.deleted_at IS NULL
            AND ((c.email_blind_index IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM contact_emails ce WHERE ce.contact_id = c.id AND ce.deleted_at IS NULL))
              OR (c.phone_enc IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM contact_phones cp WHERE cp.contact_id = c.id AND cp.deleted_at IS NULL)))`,
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  },

  // ── S-CH4 reads (05 §5/§6) — called ONLY when the composed read gate evaluated ON ──────────────────────

  /**
   * Batched MASKED channel summaries for a page of contacts (the list/search projection's `channels` field,
   * 05 §5): live-row counts + per-value `{type, status[, lineType], isPrimary}` — NEVER a value, NEVER a
   * domain (secondary email domains are PII-adjacent and stay masked until reveal; only the primary's domain
   * rides maskedContact.emailDomain, from the flat cache, unchanged). One IN-list SELECT per table for N
   * contacts (no N+1; bounded by N × the 25-value cap); primary-first ordering inside each contact. RLS on
   * the caller's tx is the isolation wall. Ids with no live rows are simply ABSENT from the map — callers
   * default to zero-counts.
   */
  async channelSummariesForContacts(
    tx: Tx,
    contactIds: string[],
  ): Promise<Map<string, ContactChannelSummaries>> {
    const out = new Map<string, ContactChannelSummaries>();
    if (contactIds.length === 0) return out;
    const entry = (id: string): ContactChannelSummaries => {
      let e = out.get(id);
      if (!e) {
        e = { emailCount: 0, phoneCount: 0, emailSummaries: [], phoneSummaries: [] };
        out.set(id, e);
      }
      return e;
    };
    const emailRows = await tx
      .select({
        contactId: contactEmails.contactId,
        type: contactEmails.type,
        status: contactEmails.status,
        isPrimary: contactEmails.isPrimary,
      })
      .from(contactEmails)
      .where(and(inArray(contactEmails.contactId, contactIds), isNull(contactEmails.deletedAt)))
      .orderBy(...emailReadOrder);
    for (const r of emailRows) {
      const e = entry(r.contactId);
      e.emailCount += 1;
      e.emailSummaries!.push({
        type: r.type,
        status: r.status,
        isPrimary: r.isPrimary,
      } as ContactEmailSummary);
    }
    const phoneRows = await tx
      .select({
        contactId: contactPhones.contactId,
        type: contactPhones.type,
        status: contactPhones.status,
        lineType: contactPhones.lineType,
        isPrimary: contactPhones.isPrimary,
      })
      .from(contactPhones)
      .where(and(inArray(contactPhones.contactId, contactIds), isNull(contactPhones.deletedAt)))
      .orderBy(...phoneReadOrder);
    for (const r of phoneRows) {
      const e = entry(r.contactId);
      e.phoneCount += 1;
      e.phoneSummaries!.push({
        type: r.type,
        status: r.status,
        lineType: r.lineType,
        isPrimary: r.isPrimary,
      } as ContactPhoneSummary);
    }
    return out;
  },

  /**
   * The LIVE email values for a batch of contacts, primary-first — the reveal/export read (05 §5: an owned
   * `email` claim unmasks ALL live email values of the contact; reveal stays contact × reveal_type grained).
   * Returns ENCRYPTED bytes — decryption happens in core, strictly behind the reveal-ownership check (the
   * masked-until-reveal boundary is the claim, never this layer). RLS-scoped via the caller's tx.
   */
  async listLiveEmailValuesByContactIds(
    tx: Tx,
    contactIds: string[],
  ): Promise<Map<string, LiveEmailChannelRow[]>> {
    const out = new Map<string, LiveEmailChannelRow[]>();
    if (contactIds.length === 0) return out;
    const rows = await tx
      .select({
        id: contactEmails.id,
        contactId: contactEmails.contactId,
        valueEnc: contactEmails.valueEnc,
        type: contactEmails.type,
        status: contactEmails.status,
        isPrimary: contactEmails.isPrimary,
      })
      .from(contactEmails)
      .where(and(inArray(contactEmails.contactId, contactIds), isNull(contactEmails.deletedAt)))
      .orderBy(...emailReadOrder);
    for (const r of rows) {
      const list = out.get(r.contactId);
      if (list) list.push(r);
      else out.set(r.contactId, [r]);
    }
    return out;
  },

  /** The LIVE phone values for a batch of contacts, primary-first — the phone twin (an owned `phone` claim
   *  unmasks all live phone values). Encrypted bytes out; core decrypts behind the ownership check. */
  async listLivePhoneValuesByContactIds(
    tx: Tx,
    contactIds: string[],
  ): Promise<Map<string, LivePhoneChannelRow[]>> {
    const out = new Map<string, LivePhoneChannelRow[]>();
    if (contactIds.length === 0) return out;
    const rows = await tx
      .select({
        id: contactPhones.id,
        contactId: contactPhones.contactId,
        valueEnc: contactPhones.valueEnc,
        type: contactPhones.type,
        status: contactPhones.status,
        lineType: contactPhones.lineType,
        extension: contactPhones.extension,
        isPrimary: contactPhones.isPrimary,
      })
      .from(contactPhones)
      .where(and(inArray(contactPhones.contactId, contactIds), isNull(contactPhones.deletedAt)))
      .orderBy(...phoneReadOrder);
    for (const r of rows) {
      const list = out.get(r.contactId);
      if (list) list.push(r);
      else out.set(r.contactId, [r]);
    }
    return out;
  },

  /**
   * The S-CH4 dedup email rung's probe (05 §6): resolve email blind indexes → contact ids through the LIVE
   * child rows. Workspace-scoped explicitly (defence-in-depth atop RLS, mirroring findByDedupKeysBatch's
   * flat SELECT); the §2.2 partial ws-unique guarantees ≤1 live row per key, so precedence semantics are
   * preserved exactly — and secondaries now resolve too (the G15/G16 payoff: a duplicate carrying a
   * secondary email lands on the contact that already holds it). One IN-list SELECT per chunk. NOTE the
   * deliberate live-rows-only asymmetry vs the flat rung (which matches soft-archived CONTACTS): archiving a
   * contact does not tombstone its child rows, so archived contacts still match here — parity holds; only an
   * explicit channel soft-delete (a doc-04 user verb) releases a key, which is the §Edge "all values
   * deleted → dedup keys release" contract.
   */
  async findContactIdsByEmailBlindIndexes(
    tx: Tx,
    workspaceId: string,
    keys: Uint8Array[],
  ): Promise<EmailBlindIndexHit[]> {
    if (keys.length === 0) return [];
    return tx
      .select({ contactId: contactEmails.contactId, blindIndex: contactEmails.blindIndex })
      .from(contactEmails)
      .where(
        and(
          eq(contactEmails.workspaceId, workspaceId),
          inArray(contactEmails.blindIndex, keys),
          isNull(contactEmails.deletedAt),
        ),
      );
  },
};
