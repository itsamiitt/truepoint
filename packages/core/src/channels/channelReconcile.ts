// channelReconcile.ts — S-CH5: the PERMANENT CH-INV-1 reconcile / drift sweep runner + its pure decider
// (import-and-data-model-redesign 05 §3.4/§5 — THE spec; 15 §M-SEQ seq 48 / §3 "permanent fixtures").
// Unlike the self-terminating S-CH3 backfill this NEVER retires (05 §5): drift = 0 is the steady state it
// holds forever. Driven fleet-wide by the leader-locked sweep in apps/workers (channelReconcileSweep.ts).
//
// WHAT DRIFT IS (CH-INV-1, 05 §3): for every live contact the flat channel columns are a byte-exact
// projection of the single live is_primary child row — or all-NULL when no live child exists. The repository
// drift predicate (contactChannelRepository.findContactsWithChannelDrift) is the checkable form: blind-index
// / value-byte / domain / status compare for emails (the flat email slot carries a blind index); value-byte
// + status + line_type for phones (the flat phone slot has NO blind index). The runner reconfirms it
// in-worker so the repair is precise per channel.
//
// THE PHASE RULE (05 §3.4 — "the job never guesses"): the repair DIRECTION is read from the per-tenant READ
// gate, evaluated fail-closed IN-TX at every batch boundary (the S-CH3 gate-eval posture):
//   • read gate OFF (dual-write era, flat is authoritative) ⇒ FLAT WINS — re-project the child primary from
//     the flat bytes. This is what closes the shipped-writer coherence gap (doc 16 S-CH2 row: an overwrite
//     that changed a value left flat holding the new value while the child primary kept the old one).
//   • read gate ON  (post-cutover, child is authoritative)  ⇒ CHILD WINS — re-project the flat cache from the
//     child primary's bytes + status mirrors.
// TENANT SELECTION + ABORT is the S-CH2 dual gate re-evaluated in-tx per batch (fail-closed): a reconcile is
// meaningful only where child rows are maintained; a flag-off tenant is censused yet never written (gateOff),
// and flipping the tenant flag off mid-run halts it at the next batch boundary.
//
// DEGENERATE STATES (05 §Edge — direction-independent, non-lossy):
//   • flat present, NO live child row  ⇒ create the child primary from flat (the S-CH3 backfill primitive).
//   • live primary child, flat null    ⇒ project the flat cache from the child (never null a real value).
//   • both null                        ⇒ no-op.
//   • live rows but NO primary (vacuum) ⇒ flat-wins: make the flat-valued row the primary; child-wins: promote
//     the oldest live row, then project flat from it.
//
// SKIP-LOUD (never wedge): a contact whose flat phone ciphertext fails to decrypt (a flat-wins phone repair
// needs the plaintext to re-derive the blind index / E.164 material) or whose flat email bytes are incomplete
// is skipped per-contact BEFORE any write (counted, logged) — it stays in the drift count so the gauge never
// lies, exactly the S-CH3 posture. Out-of-vocabulary legacy phone GRADES (contacts has no DB CHECK on
// phone_status/phone_line_type; the child columns do) are the one non-convergent case flat-wins: the built
// (sanitized) value already equals the child, so the write is a no-op (no updated_at churn) and the raw
// divergence stays visible as steady drift for manual triage — child-wins clears it by adopting the sanitized
// grade. See the doc-16 S-CH5 drift rows.
//
// REUSE (CH-INV-1 single-pathed): the flat-wins BUILT payloads are produced by the S-CH3
// planContactChannelBackfill (verbatim email bytes; phone decrypt→toE164→sanitize — DM1, zero new
// normalizers), so a flat-wins repair writes byte-for-byte what the backfill would have. Creates route
// through the same backfillContactChannels insert. The repository owns every SQL write (house rule); this
// module owns the decision + orchestration inside the caller's withTenantTx.

import {
  type ChannelDriftRow,
  contactChannelRepository,
  type MissingChannelProjectionRow,
  type ReconcileEmailRow,
  type ReconcilePhoneRow,
  type Tx,
  withTenantTx,
} from "@leadwolf/db";
import { decryptPii } from "../import/encryptPii.ts";
import { planContactChannelBackfill } from "./channelBackfill.ts";
import { isChannelDualWriteEnabled } from "./channelDualWrite.ts";
import { isChannelReadFromChildEnabled } from "./channelRead.ts";

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.from(a).equals(Buffer.from(b));

export type ReconcileDirection = "flat" | "child";

/** The repair one channel takes (the pure decider's output — the repository executes it). */
export type ChannelReconcileAction =
  | "noop"
  /** child-wins (+ the "child primary, no flat" degenerate): rewrite the flat cache from the primary child. */
  | "project_flat_from_child"
  /** flat-wins: byte-refresh / in-place rewrite the EXISTING primary from the flat bytes. */
  | "write_primary_from_flat"
  /** flat-wins: demote the current primary, promote the live row that holds the flat value (the coherence gap). */
  | "swap_to_flat"
  /** degenerate-1 / flat-wins vacuum with no matching row: insert the primary from flat (backfill primitive). */
  | "create_from_flat"
  /** child-wins vacuum: promote the oldest live row, then project the flat cache from it. */
  | "promote_oldest_then_project_flat";

/** The reconcile state one channel presents to the pure decider (computed from the live child rows + the flat
 *  columns + the flat-derived BUILT payload). All comparisons are against the RAW flat columns (true
 *  CH-INV-1) except `builtEqualsPrimary`, which detects the non-representable-grade phantom. */
export interface ChannelReconcileState {
  hasFlat: boolean;
  anyLiveChild: boolean;
  primaryExists: boolean;
  /** The live primary is byte-exact + grade-exact to the RAW flat columns (the SQL predicate's negation). */
  primaryCoherent: boolean;
  /** The current primary holds the flat VALUE (its blind index equals flat's). */
  primaryMatchesFlatValue: boolean;
  /** SOME live row (primary or secondary) holds the flat value. */
  flatValueLiveRowExists: boolean;
  /** The flat-derived BUILT payload equals the current primary (byte + sanitized grade) — the phantom guard:
   *  true while primaryCoherent is false ⇒ the flat carries a grade the child CHECK can't hold; a flat-wins
   *  write would churn without converging, so it is a no-op. */
  builtEqualsPrimary: boolean;
}

/**
 * THE pure drift decider (unit-tested, IO-free): given the reconcile state + the phase direction, decide the
 * repair. Every branch is 05 §3.4 / §Edge restated. Flat-sourced actions (write/swap/create) still require a
 * projectable flat (the executor skips-loud when the BUILT payload is absent — decrypt failed / bytes
 * incomplete); the decider assumes projectability and lets the executor enforce it.
 */
export function decideChannelReconcile(
  direction: ReconcileDirection,
  s: ChannelReconcileState,
): ChannelReconcileAction {
  if (!s.hasFlat) {
    // Degenerate-2 (child primary, no flat) ⇒ fill the flat cache from the child (non-lossy, both
    // directions). Both null (or non-primary orphans without flat) ⇒ nothing this sweep owns.
    return s.primaryExists ? "project_flat_from_child" : "noop";
  }
  // Degenerate-1 (flat present, no live child at all) ⇒ create the child primary from flat (both directions —
  // nulling the flat cache would be data loss; there is nothing to project FROM).
  if (!s.anyLiveChild) return "create_from_flat";

  if (direction === "child") {
    if (s.primaryExists) return s.primaryCoherent ? "noop" : "project_flat_from_child";
    return "promote_oldest_then_project_flat"; // vacuum
  }

  // direction === "flat"
  if (s.primaryExists && (s.primaryCoherent || s.builtEqualsPrimary)) return "noop";
  if (s.flatValueLiveRowExists) {
    return s.primaryMatchesFlatValue ? "write_primary_from_flat" : "swap_to_flat";
  }
  if (s.primaryExists) return "write_primary_from_flat"; // rewrite the stale primary in place
  return "create_from_flat"; // vacuum with no row holding the flat value
}

/** One channel's repair outcome, as the runner tallies it. */
type RepairOutcome = "repaired_flat" | "repaired_child" | "skipped" | "noop";

/** The flat email bytes, verbatim (== the S-CH3 BackfillEmailChild). */
interface EmailBuilt {
  valueEnc: Uint8Array;
  blindIndex: Uint8Array;
  emailDomain: string;
  status: string;
}
/** The flat phone bytes + re-derived E.164 material (== the S-CH3 BackfillPhoneChild). */
interface PhoneBuilt {
  valueEnc: Uint8Array;
  blindIndex: Uint8Array;
  e164Enc: Uint8Array | null;
  e164BlindIndex: Uint8Array | null;
  countryHint: string | null;
  status: string | null;
  lineType: string | null;
  lineTypeSource: string | null;
}

function computeEmailState(
  live: ReconcileEmailRow[],
  flat: { emailEnc: Uint8Array | null; emailBlindIndex: Uint8Array | null; emailDomain: string | null; emailStatus: string },
  built: EmailBuilt | undefined,
): ChannelReconcileState {
  const primary = live.find((r) => r.isPrimary);
  const flatRow = built ? live.find((r) => bytesEqual(r.blindIndex, built.blindIndex)) : undefined;
  const primaryCoherent =
    !!primary &&
    flat.emailEnc !== null &&
    flat.emailBlindIndex !== null &&
    bytesEqual(primary.valueEnc, flat.emailEnc) &&
    bytesEqual(primary.blindIndex, flat.emailBlindIndex) &&
    primary.emailDomain === flat.emailDomain &&
    primary.status === flat.emailStatus;
  const builtEqualsPrimary =
    !!primary &&
    !!built &&
    bytesEqual(primary.valueEnc, built.valueEnc) &&
    bytesEqual(primary.blindIndex, built.blindIndex) &&
    primary.emailDomain === built.emailDomain &&
    primary.status === built.status;
  return {
    hasFlat: flat.emailBlindIndex !== null,
    anyLiveChild: live.length > 0,
    primaryExists: !!primary,
    primaryCoherent,
    primaryMatchesFlatValue: !!primary && !!flatRow && primary.id === flatRow.id,
    flatValueLiveRowExists: !!flatRow,
    builtEqualsPrimary,
  };
}

function computePhoneState(
  live: ReconcilePhoneRow[],
  flat: { phoneEnc: Uint8Array | null; phoneStatus: string | null; phoneLineType: string | null },
  built: PhoneBuilt | undefined,
): ChannelReconcileState {
  const primary = live.find((r) => r.isPrimary);
  const flatRow = built ? live.find((r) => bytesEqual(r.blindIndex, built.blindIndex)) : undefined;
  const primaryCoherent =
    !!primary &&
    flat.phoneEnc !== null &&
    bytesEqual(primary.valueEnc, flat.phoneEnc) &&
    (primary.status ?? null) === (flat.phoneStatus ?? null) &&
    (primary.lineType ?? null) === (flat.phoneLineType ?? null);
  const builtEqualsPrimary =
    !!primary &&
    !!built &&
    bytesEqual(primary.valueEnc, built.valueEnc) &&
    (primary.status ?? null) === (built.status ?? null) &&
    (primary.lineType ?? null) === (built.lineType ?? null);
  return {
    hasFlat: flat.phoneEnc !== null,
    anyLiveChild: live.length > 0,
    primaryExists: !!primary,
    primaryCoherent,
    primaryMatchesFlatValue: !!primary && !!flatRow && primary.id === flatRow.id,
    flatValueLiveRowExists: !!flatRow,
    builtEqualsPrimary,
  };
}

const oldest = <T extends { firstSeenAt: Date }>(rows: T[]): T =>
  [...rows].sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime())[0] as T;

/** Build a MissingChannelProjectionRow view of a drift row so the S-CH3 planContactChannelBackfill produces
 *  the flat-wins BUILT payloads verbatim (email bytes verbatim; phone decrypt→derive→sanitize). */
function asMissing(
  row: ChannelDriftRow,
  needsEmail: boolean,
  needsPhone: boolean,
): MissingChannelProjectionRow {
  return {
    id: row.id,
    needsEmail,
    needsPhone,
    emailEnc: row.emailEnc,
    emailBlindIndex: row.emailBlindIndex,
    emailDomain: row.emailDomain,
    emailStatus: row.emailStatus,
    phoneEnc: row.phoneEnc,
    phoneStatus: row.phoneStatus,
    phoneLineType: row.phoneLineType,
    locationCountry: row.locationCountry,
  };
}

export interface ChannelReconcileOptions {
  /** Contacts per keyset batch (one tx per batch). Default 1 000 (15 §2.1). */
  batchSize?: number;
  /** Batches per call — the sweep's per-tick bound; residual drift drains across ticks. */
  maxBatches?: number;
}

export interface ChannelReconcileWorkspaceResult {
  scanned: number;
  /** Drifting CHANNELS the walker saw (email + phone counted separately) — includes phantom no-ops, so it is
   *  a truer detection count than repaired + skipped. */
  detected: number;
  emailsRepaired: number;
  phonesRepaired: number;
  /** Repairs in the FLAT-wins direction (child re-projected from flat). */
  flatWins: number;
  /** Repairs in the CHILD-wins direction (flat re-projected from child). */
  childWins: number;
  /** Undecryptable / incomplete-flat contacts skipped before any write (counted, never wedged). */
  skipped: number;
  batches: number;
  /** The walk exhausted the workspace's drift set this call (final batch under-filled). */
  drained: boolean;
  /** The dual gate read OFF at a batch boundary — halted fail-closed (also the dynamic abort). */
  gateOff: boolean;
  /** The repair direction the last processed batch used (read gate ON ⇒ child-wins). */
  readGateOn: boolean;
}

interface BatchOutcome {
  gateOff: boolean;
  rows: number;
  lastId: string | null;
  detected: number;
  emailsRepaired: number;
  phonesRepaired: number;
  flatWins: number;
  childWins: number;
  skipped: number;
  readGateOn: boolean;
}

/** Execute a decided EMAIL repair inside the caller's tx. Returns the outcome the runner tallies. */
async function executeEmailRepair(
  tx: Tx,
  scope: { tenantId: string; workspaceId: string },
  contactId: string,
  action: ChannelReconcileAction,
  live: ReconcileEmailRow[],
  built: EmailBuilt | undefined,
): Promise<RepairOutcome> {
  const primary = live.find((r) => r.isPrimary);
  switch (action) {
    case "noop":
      return "noop";
    case "project_flat_from_child": {
      if (!primary) return "noop";
      await contactChannelRepository.projectEmailChildToFlat(tx, contactId, {
        valueEnc: primary.valueEnc,
        blindIndex: primary.blindIndex,
        emailDomain: primary.emailDomain,
        status: primary.status,
      });
      return "repaired_child";
    }
    case "write_primary_from_flat": {
      if (!built || !primary) return "skipped";
      await contactChannelRepository.writeEmailPrimaryFromBytes(tx, primary.id, built);
      return "repaired_flat";
    }
    case "swap_to_flat": {
      if (!built) return "skipped";
      const flatRow = live.find((r) => bytesEqual(r.blindIndex, built.blindIndex));
      if (!flatRow) return "skipped";
      if (primary) await contactChannelRepository.demoteEmailRow(tx, primary.id);
      await contactChannelRepository.writeEmailPrimaryFromBytes(tx, flatRow.id, built);
      return "repaired_flat";
    }
    case "create_from_flat": {
      if (!built) return "skipped";
      await contactChannelRepository.backfillContactChannels(tx, scope, contactId, { email: built });
      return "repaired_flat";
    }
    case "promote_oldest_then_project_flat": {
      if (live.length === 0) return "noop";
      const o = oldest(live);
      await contactChannelRepository.promoteEmailRow(tx, o.id);
      await contactChannelRepository.projectEmailChildToFlat(tx, contactId, {
        valueEnc: o.valueEnc,
        blindIndex: o.blindIndex,
        emailDomain: o.emailDomain,
        status: o.status,
      });
      return "repaired_child";
    }
  }
}

/** Execute a decided PHONE repair inside the caller's tx. */
async function executePhoneRepair(
  tx: Tx,
  scope: { tenantId: string; workspaceId: string },
  contactId: string,
  action: ChannelReconcileAction,
  live: ReconcilePhoneRow[],
  built: PhoneBuilt | undefined,
): Promise<RepairOutcome> {
  const primary = live.find((r) => r.isPrimary);
  switch (action) {
    case "noop":
      return "noop";
    case "project_flat_from_child": {
      if (!primary) return "noop";
      await contactChannelRepository.projectPhoneChildToFlat(tx, contactId, {
        valueEnc: primary.valueEnc,
        status: primary.status,
        lineType: primary.lineType,
      });
      return "repaired_child";
    }
    case "write_primary_from_flat": {
      if (!built || !primary) return "skipped";
      await contactChannelRepository.writePhonePrimaryFromBuilt(tx, primary.id, built);
      return "repaired_flat";
    }
    case "swap_to_flat": {
      if (!built) return "skipped";
      const flatRow = live.find((r) => bytesEqual(r.blindIndex, built.blindIndex));
      if (!flatRow) return "skipped";
      if (primary) await contactChannelRepository.demotePhoneRow(tx, primary.id);
      await contactChannelRepository.writePhonePrimaryFromBuilt(tx, flatRow.id, built);
      return "repaired_flat";
    }
    case "create_from_flat": {
      if (!built) return "skipped";
      await contactChannelRepository.backfillContactChannels(tx, scope, contactId, { phone: built });
      return "repaired_flat";
    }
    case "promote_oldest_then_project_flat": {
      if (live.length === 0) return "noop";
      const o = oldest(live);
      await contactChannelRepository.promotePhoneRow(tx, o.id);
      await contactChannelRepository.projectPhoneChildToFlat(tx, contactId, {
        valueEnc: o.valueEnc,
        status: o.status,
        lineType: o.lineType,
      });
      return "repaired_child";
    }
  }
}

function tally(outcome: RepairOutcome, out: BatchOutcome, channel: "email" | "phone"): void {
  if (outcome === "skipped") {
    out.skipped += 1;
    return;
  }
  if (outcome === "noop") return;
  if (channel === "email") out.emailsRepaired += 1;
  else out.phonesRepaired += 1;
  if (outcome === "repaired_flat") out.flatWins += 1;
  else out.childWins += 1;
}

/**
 * Reconcile ONE workspace's channel drift, up to `maxBatches` keyset batches. Idempotent + resumable by
 * construction (the WHERE-drift selection IS the watermark — a repaired contact drops out; a re-run touches
 * only residual drift; a coherent workspace does zero writes). The sweep re-invokes it every tick — forever.
 */
export async function runChannelReconcileForWorkspace(
  scope: { tenantId: string; workspaceId: string },
  opts: ChannelReconcileOptions = {},
): Promise<ChannelReconcileWorkspaceResult> {
  const batchSize = opts.batchSize ?? 1000;
  const maxBatches = opts.maxBatches ?? 10;
  const result: ChannelReconcileWorkspaceResult = {
    scanned: 0,
    detected: 0,
    emailsRepaired: 0,
    phonesRepaired: 0,
    flatWins: 0,
    childWins: 0,
    skipped: 0,
    batches: 0,
    drained: false,
    gateOff: false,
    readGateOn: false,
  };
  let cursor: string | null = null;
  for (let i = 0; i < maxBatches; i++) {
    const batch: BatchOutcome = await withTenantTx(scope, async (tx) => {
      const out: BatchOutcome = {
        gateOff: false,
        rows: 0,
        lastId: null,
        detected: 0,
        emailsRepaired: 0,
        phonesRepaired: 0,
        flatWins: 0,
        childWins: 0,
        skipped: 0,
        readGateOn: false,
      };
      // Batch-boundary gate: tenant selection + the dynamic abort (fail-closed) — a reconcile only runs where
      // dual-write is live (child rows are maintained), the S-CH3 mechanism reused verbatim.
      if (!(await isChannelDualWriteEnabled(tx, scope.tenantId))) {
        out.gateOff = true;
        return out;
      }
      // The phase rule: the READ gate picks the repair direction (ON ⇒ child wins; OFF ⇒ flat wins).
      const direction: ReconcileDirection = (await isChannelReadFromChildEnabled(tx, scope.tenantId))
        ? "child"
        : "flat";
      out.readGateOn = direction === "child";

      const rows = await contactChannelRepository.findContactsWithChannelDrift(tx, cursor, batchSize);
      out.rows = rows.length;
      out.lastId = rows.length > 0 ? (rows[rows.length - 1]?.id ?? null) : null;

      for (const row of rows) {
        // Flat-wins repairs need the flat value re-derived (email verbatim; phone decrypt→toE164→sanitize) —
        // built ONLY for the flat direction; child-wins reads child bytes, no decrypt. A decrypt failure is
        // absorbed as phoneSkipped by the shipped planner (skip-loud, never wedge).
        let emailBuilt: EmailBuilt | undefined;
        let phoneBuilt: PhoneBuilt | undefined;
        if (direction === "flat") {
          let phonePlain: string | null = null;
          if (row.phoneDrifts && row.phoneEnc) {
            try {
              phonePlain = decryptPii(row.phoneEnc);
            } catch {
              phonePlain = null; // corrupt ciphertext — the planner marks phoneSkipped ⇒ executor skips-loud
            }
          }
          const plan = planContactChannelBackfill(
            asMissing(row, row.emailDrifts, row.phoneDrifts),
            phonePlain,
          );
          emailBuilt = plan.email;
          phoneBuilt = plan.phone;
        }

        if (row.emailDrifts) {
          out.detected += 1;
          const live = await contactChannelRepository.loadLiveEmailRowsForReconcile(tx, row.id);
          const state = computeEmailState(live, row, emailBuilt);
          const action = decideChannelReconcile(direction, state);
          tally(await executeEmailRepair(tx, scope, row.id, action, live, emailBuilt), out, "email");
        }
        if (row.phoneDrifts) {
          out.detected += 1;
          const live = await contactChannelRepository.loadLivePhoneRowsForReconcile(tx, row.id);
          const state = computePhoneState(live, row, phoneBuilt);
          const action = decideChannelReconcile(direction, state);
          tally(await executePhoneRepair(tx, scope, row.id, action, live, phoneBuilt), out, "phone");
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
    result.detected += batch.detected;
    result.emailsRepaired += batch.emailsRepaired;
    result.phonesRepaired += batch.phonesRepaired;
    result.flatWins += batch.flatWins;
    result.childWins += batch.childWins;
    result.skipped += batch.skipped;
    result.readGateOn = batch.readGateOn;
    if (batch.rows < batchSize) {
      result.drained = true;
      break;
    }
    cursor = batch.lastId;
  }
  return result;
}
