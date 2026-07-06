// channelBackfill.ts — S-CH3: the per-workspace channel backfill runner (import-and-data-model-redesign
// 15 §2.1 — THE binding mechanics; 05 §Implementation S-CH3 row). Copies every existing contact's flat
// email/phone into its `is_primary` child row so the family can converge on completeness = 0 (the S-CH4
// gate). Driven fleet-wide by the leader-locked sweep in apps/workers (channelBackfillSweep.ts).
//
// THE CONTRACT, pinned (15 §2.1):
//   • Connection posture: `withTenantTx` per batch — NEVER the owner connection for writes (rule 7; the one
//     sanctioned owner-conn bypass is COPY staging). RLS is ENFORCING during backfill, not bypassed.
//   • Iteration: keyset walk over `contacts.id` (uuid v7 ⇒ time-ordered stable cursor), batches of 1 000
//     (env-tunable), ONE tx per batch, each batch commits — no long transactions, ordinary MVCC.
//   • Watermark/resume: the WHERE-missing selection IS the watermark — a contact is selected only while it
//     still lacks a live child row of a flat-populated channel, so a crash/abort resumes by re-selecting and
//     a re-run is an idempotent no-op on done contacts (twice = once; no stored cursor row; 16 drift row).
//   • Abort: the S-CH2 dual gate (CHANNEL_DUAL_WRITE env + per-tenant `channels_dual_write`) is re-evaluated
//     IN-TX at EVERY batch boundary — flag off ⇒ the walk halts before the next batch (fail-closed tenant
//     selection AND the 15 §2.1 batch-boundary kill flag, one mechanism). Abort leaves a consistent,
//     partially-backfilled state that is INVISIBLE to users (reads stay flat until S-CH4).
//   • EMAIL: ciphertext + blind index copied byte-VERBATIM from the flat columns — never decrypted, never
//     re-encrypted, never re-normalized (CH-INV-1 holds by construction). PHONE: decrypted IN-WORKER via
//     core's decryptPii (the reveal/re-verify precedent) → the shipped buildPhoneChannelValue derives the
//     raw blind index + E.164 material (hint from locationCountry, else raw-only); value_enc stays the flat
//     bytes verbatim; unparseable ⇒ e164 NULL, kept + flagged, NEVER skipped (05 §4).
//   • Per-contact all-or-nothing: a contact's email+phone projections ride the same batch tx — any genuine
//     DB error aborts the whole batch, so no half-projected contact ever commits (no-partial-visibility).
//   • Never touches existing child rows: selection is WHERE-missing per channel; a contact that already got
//     its child row via S-CH2 (any order) is skipped for that channel; ON CONFLICT DO NOTHING backstops the
//     concurrent-dual-write race (their row wins, counted as a conflict, never an error).
//
// Contacts that CANNOT be projected (phone ciphertext that fails decrypt; a flat email key with incomplete
// bytes/domain) are skipped per-contact — deliberately: they stay in the completeness count, so the S-CH4
// gate stays honestly blocked and loud (the remaining gauge never lies) instead of the batch wedging.

import {
  type BackfillEmailChild,
  type BackfillPhoneChild,
  contactChannelRepository,
  type MissingChannelProjectionRow,
  withTenantTx,
} from "@leadwolf/db";
import { phoneLineType, phoneStatus } from "@leadwolf/types";
import { decryptPii } from "../import/encryptPii.ts";
import {
  buildPhoneChannelValue,
  countryHintOf,
  isChannelDualWriteEnabled,
} from "./channelDualWrite.ts";

const PHONE_STATUS_VALUES = new Set<string>(phoneStatus.options);
const LINE_TYPE_VALUES = new Set<string>(phoneLineType.options);

/** What the backfill will write for ONE contact — the pure batch decider's output (unit-testable, no IO). */
export interface ContactChannelBackfillPlan {
  email?: BackfillEmailChild;
  phone?: BackfillPhoneChild;
  /** Phone kept raw with NULL e164 material (05 §4 — flagged, never fatal). */
  phoneUnparseable: boolean;
  /** needsEmail but the flat bytes/domain are incomplete — contact left in the completeness count, loud. */
  emailSkipped: boolean;
  /** needsPhone but the ciphertext failed decrypt (phonePlain null) — same posture. */
  phoneSkipped: boolean;
  /** A flat grade outside the shipped vocabulary was coerced (line_type → 'unknown' per 05 §Edge; an
   *  out-of-vocab phone_status → NULL) — possible only for legacy rows (contacts has no DB CHECK on either). */
  gradesSanitized: boolean;
}

/**
 * The pure per-contact decider (the S-CH3 "batch decider"): flat row + the worker-decrypted phone plaintext
 * (null = decrypt failed or no phone) → the child payloads. Email bytes pass through VERBATIM — this
 * function never sees an email plaintext. Phone derivation reuses the S-CH2 builder (DM1: shipped
 * toE164/blindIndex/encryptPii, zero new normalizers); the decrypted plaintext IS the cleaned as-entered
 * form the flat writer stored, so it is passed through un-re-normalized (value_enc must stay flat-verbatim).
 */
export function planContactChannelBackfill(
  row: MissingChannelProjectionRow,
  phonePlain: string | null,
): ContactChannelBackfillPlan {
  const plan: ContactChannelBackfillPlan = {
    phoneUnparseable: false,
    emailSkipped: false,
    phoneSkipped: false,
    gradesSanitized: false,
  };
  if (row.needsEmail) {
    if (row.emailEnc && row.emailBlindIndex && row.emailDomain) {
      plan.email = {
        valueEnc: row.emailEnc, // VERBATIM — CH-INV-1's byte projection
        blindIndex: row.emailBlindIndex, // VERBATIM
        emailDomain: row.emailDomain,
        status: row.emailStatus, // status mirror (flat wins; contacts' own DB CHECK guarantees the vocab)
      };
    } else {
      plan.emailSkipped = true;
    }
  }
  if (row.needsPhone) {
    if (row.phoneEnc && phonePlain !== null) {
      const built = buildPhoneChannelValue({
        cleaned: phonePlain,
        phoneEnc: row.phoneEnc, // VERBATIM — the flat ciphertext IS the child value_enc
        countryHint: countryHintOf(row.locationCountry),
      });
      let status = row.phoneStatus;
      if (status !== null && !PHONE_STATUS_VALUES.has(status)) {
        status = null;
        plan.gradesSanitized = true;
      }
      let lineType = row.phoneLineType;
      if (lineType !== null && !LINE_TYPE_VALUES.has(lineType)) {
        lineType = "unknown"; // 05 §Edge: outside the union → 'unknown', never rejected
        plan.gradesSanitized = true;
      }
      plan.phone = {
        valueEnc: built.valueEnc,
        blindIndex: built.blindIndex,
        e164Enc: built.e164Enc ?? null,
        e164BlindIndex: built.e164BlindIndex ?? null,
        countryHint: built.countryHint ?? null,
        status,
        lineType,
        // A mirrored flat line_type came from the phone verifier (the only shipped flat writer) —
        // the same carrier_lookup attribution S-CH2's primary designation uses.
        lineTypeSource: lineType !== null ? "carrier_lookup" : null,
      };
      plan.phoneUnparseable = plan.phone.e164Enc === null;
    } else {
      plan.phoneSkipped = true;
    }
  }
  return plan;
}

export interface ChannelBackfillOptions {
  /** Contacts per keyset batch (one tx per batch). 15 §2.1 default: 1 000. */
  batchSize?: number;
  /** Batches processed per call — the sweep's per-tick bound; a whale drains across ticks. */
  maxBatches?: number;
}

export interface ChannelBackfillWorkspaceResult {
  scanned: number;
  emailsCreated: number;
  phonesCreated: number;
  phonesUnparseable: number;
  conflictsSkipped: number;
  contactsSkipped: number;
  gradesSanitized: number;
  batches: number;
  /** The walk exhausted the workspace's missing set this call (final batch under-filled). */
  drained: boolean;
  /** The dual gate read OFF at a batch boundary — halted fail-closed (also the dynamic abort). */
  gateOff: boolean;
}

interface BatchOutcome {
  gateOff: boolean;
  rows: number;
  lastId: string | null;
  emailsCreated: number;
  phonesCreated: number;
  phonesUnparseable: number;
  conflictsSkipped: number;
  contactsSkipped: number;
  gradesSanitized: number;
}

/**
 * Backfill ONE workspace's missing channel projections, up to `maxBatches` keyset batches. Safe to call any
 * number of times in any order relative to S-CH2 traffic (idempotent, WHERE-missing, conflict-backstopped);
 * the sweep re-invokes it every tick until the census stops returning the workspace.
 */
export async function runChannelBackfillForWorkspace(
  scope: { tenantId: string; workspaceId: string },
  opts: ChannelBackfillOptions = {},
): Promise<ChannelBackfillWorkspaceResult> {
  const batchSize = opts.batchSize ?? 1000;
  const maxBatches = opts.maxBatches ?? 10;
  const result: ChannelBackfillWorkspaceResult = {
    scanned: 0,
    emailsCreated: 0,
    phonesCreated: 0,
    phonesUnparseable: 0,
    conflictsSkipped: 0,
    contactsSkipped: 0,
    gradesSanitized: 0,
    batches: 0,
    drained: false,
    gateOff: false,
  };
  let cursor: string | null = null;
  for (let i = 0; i < maxBatches; i++) {
    const batch: BatchOutcome = await withTenantTx(scope, async (tx) => {
      const out: BatchOutcome = {
        gateOff: false,
        rows: 0,
        lastId: null,
        emailsCreated: 0,
        phonesCreated: 0,
        phonesUnparseable: 0,
        conflictsSkipped: 0,
        contactsSkipped: 0,
        gradesSanitized: 0,
      };
      // Batch-boundary gate check (fail-closed tenant selection + the 15 §2.1 abort flag, one mechanism).
      if (!(await isChannelDualWriteEnabled(tx, scope.tenantId))) {
        out.gateOff = true;
        return out;
      }
      const rows = await contactChannelRepository.findContactsMissingChannelProjection(
        tx,
        cursor,
        batchSize,
      );
      out.rows = rows.length;
      out.lastId = rows.length > 0 ? (rows[rows.length - 1]?.id ?? null) : null;
      for (const row of rows) {
        // Decrypt the phone IN-WORKER, per contact, BEFORE any insert for the contact — a decrypt failure
        // skips the contact cleanly (nothing written for it yet) instead of aborting the batch.
        let phonePlain: string | null = null;
        if (row.needsPhone && row.phoneEnc) {
          try {
            phonePlain = decryptPii(row.phoneEnc);
          } catch {
            phonePlain = null; // corrupted ciphertext — planContactChannelBackfill marks phoneSkipped
          }
        }
        const plan = planContactChannelBackfill(row, phonePlain);
        if (plan.emailSkipped || plan.phoneSkipped) out.contactsSkipped += 1;
        if (plan.gradesSanitized) out.gradesSanitized += 1;
        if (plan.email || plan.phone) {
          const res = await contactChannelRepository.backfillContactChannels(tx, scope, row.id, {
            email: plan.email,
            phone: plan.phone,
          });
          if (res.emailInserted) out.emailsCreated += 1;
          if (res.phoneInserted) {
            out.phonesCreated += 1;
            if (plan.phoneUnparseable) out.phonesUnparseable += 1;
          }
          out.conflictsSkipped += res.conflicts;
        }
      }
      return out;
    });
    if (batch.gateOff) {
      result.gateOff = true;
      break;
    }
    result.batches += 1;
    result.scanned += batch.rows;
    result.emailsCreated += batch.emailsCreated;
    result.phonesCreated += batch.phonesCreated;
    result.phonesUnparseable += batch.phonesUnparseable;
    result.conflictsSkipped += batch.conflictsSkipped;
    result.contactsSkipped += batch.contactsSkipped;
    result.gradesSanitized += batch.gradesSanitized;
    if (batch.rows < batchSize) {
      result.drained = true;
      break;
    }
    cursor = batch.lastId;
  }
  return result;
}
