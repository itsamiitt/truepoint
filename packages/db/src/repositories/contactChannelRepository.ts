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
// STATUS MIRROR (flat wins while S-CH2/S-CH3 are the world, 05 §3.4): on primary designation the child row's
// status columns are stamped FROM the contact's flat status columns (email_status / phone_status /
// phone_line_type) so CH-INV-1 holds including statuses at write time; the verify ops keep them in step
// afterwards. Residual drift (e.g. the shipped writers not resetting flat status on a value change) is the
// S-CH5 sweep's flat-wins repair case.

import { MAX_CHANNEL_VALUES_PER_CONTACT } from "@leadwolf/types";
import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../client.ts";
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
};
