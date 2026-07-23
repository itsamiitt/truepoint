// @forge/core verification — the human verification & approval workflow (10). The maker-checker (four-eyes)
// gate that promotes candidates into the verified_records GOLD layer — the ONLY layer that syncs (L2). The
// invariant is a WRITE-PATH control, not UI polish: `requested_by != decided_by` enforced in the executor
// [S57][S115]; a below-threshold record cannot promote; and the promotion + its sync_outbox row commit in ONE
// transaction (no dual-write, [S20]). The transactional write-set is an injected PORT so this is unit-testable.
import { createHash } from "node:crypto";
import { contentHashHex } from "@leadwolf/identity";

// ── review queue prioritization (10 §2) — ranked, never FIFO [S54] ────────────────────────────────────
export type ReviewTaskType =
  | "er_grey_zone"
  | "ai_low_confidence"
  | "dq_flag"
  | "merge_review"
  | "manual";

export interface PriorityInputs {
  /** 0..1; LOWER (more uncertain) → higher priority (review the contentious first). */
  confidence: number;
  /** 0..1 downstream importance (decision-maker seniority, corroboration, high-intent tenant). */
  value: number;
  /** 0..1 decay pressure (B2B data decays ~2.5%/mo — review before value evaporates). */
  freshness: number;
  /** 0..1 promotion blast-radius (bulk, sensitive PII, DPDP data, irreversible-ish merge). */
  risk: number;
}

const P_CONF = 0.4;
const P_VALUE = 0.25;
const P_FRESH = 0.15;
const P_RISK = 0.2;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Weighted composite → higher = review first (10 §2 [S54]); uncertainty dominates. Materialized on write. */
export function computePriority(i: PriorityInputs): number {
  const score =
    P_CONF * (1 - clamp01(i.confidence)) +
    P_VALUE * clamp01(i.value) +
    P_FRESH * clamp01(i.freshness) +
    P_RISK * clamp01(i.risk);
  return Math.round(score * 1000);
}

// ── the four-eyes promotion gate (10 §5) ──────────────────────────────────────────────────────────────
/** Below this confidence a candidate CANNOT promote (10 §Success 2; the value is OQ-R13, pilot-calibrated). */
export const VERIFY_THRESHOLD = 0.8;

export interface PromotionChannels {
  emailBlindIndex?: string;
  emailEnc?: string;
  phoneBlindIndex?: string;
  phoneEnc?: string;
}

export interface PromotionCandidate {
  contentHash: string;
  entityKind: "person" | "company";
  fields: unknown;
  confidence: number;
  channels?: PromotionChannels;
}

export interface ApprovalRequest {
  id: string;
  requestedByUserId: string;
  candidates: PromotionCandidate[];
}

/** The silver→gold inputs the verify stage assembles into a candidate: the deterministic parsed fields plus the
 *  AI-extract per-field confidence/band signal. Channels are blind-index only (no clear PII flows through here). */
export interface VerifyInputs {
  entityKind: "person" | "company";
  parsedFields: unknown;
  extractions: Array<{ confidence: number; band: string }>;
  channels?: PromotionChannels;
}

/** Assemble a gold PromotionCandidate from the silver outputs, SERVER-side — this is what makes four-eyes
 *  trustworthy (P-01.10): the fields, confidence, and content_hash all come from persisted pipeline state, never
 *  the approver's request body. The gold fields are the deterministic parse output; confidence is the
 *  CONSERVATIVE floor across the auto-band AI extractions (the weakest corroborated field gates promotion) and is
 *  0 when there is no auto-band signal, so a record can never auto-clear VERIFY_THRESHOLD without real evidence.
 *  content_hash is the stable hash of the content (the gold dedup/idempotency key). F2 refines the per-field
 *  merge + a calibrated score. */
export function assembleVerifiedCandidate(input: VerifyInputs): PromotionCandidate {
  const auto = input.extractions.filter((e) => e.band === "auto");
  const confidence = auto.length > 0 ? Math.min(...auto.map((e) => e.confidence)) : 0;
  return {
    contentHash: contentHashHex({ entityKind: input.entityKind, fields: input.parsedFields }),
    entityKind: input.entityKind,
    fields: input.parsedFields,
    confidence,
    channels: input.channels,
  };
}

export class FourEyesViolationError extends Error {
  constructor() {
    super("four-eyes violation: the checker must differ from the maker");
    this.name = "FourEyesViolationError";
  }
}

/** The transactional promotion — writes the full row-set ATOMICALLY (verified_* + verified_record_events +
 *  sync_state + sync_outbox in the SAME tx + hash-chained forge_audit_log). db-backed in prod; idempotent on
 *  content_hash, so a replayed approval is a no-op (10 §5). */
export interface PromotionTx {
  promote(input: {
    candidate: PromotionCandidate;
    approvalRequestId: string;
    approvedByUserId: string;
  }): Promise<{ verifiedId: string; written: boolean }>;
}

export interface PromotionItemResult {
  contentHash: string;
  status: "promoted" | "duplicate" | "blocked";
  reason?: string;
  verifiedId?: string;
}

export interface ApprovalResult {
  approved: number;
  duplicate: number;
  blocked: number;
  items: PromotionItemResult[];
}

/** Approve + execute a promotion under four-eyes (10 §5). Enforces checker ≠ maker in the WRITE PATH before
 *  anything runs [S57][S115], blocks below-threshold candidates, and promotes each approved candidate in its
 *  own idempotent tx. Bulk per-item maker-skipping (10 §6) is a later refinement; a reject never reaches here. */
export async function approvePromotion(
  tx: PromotionTx,
  req: ApprovalRequest,
  decidedByUserId: string,
): Promise<ApprovalResult> {
  if (req.requestedByUserId === decidedByUserId) throw new FourEyesViolationError();

  const items: PromotionItemResult[] = [];
  let approved = 0;
  let duplicate = 0;
  let blocked = 0;

  for (const candidate of req.candidates) {
    if (candidate.confidence < VERIFY_THRESHOLD) {
      blocked += 1;
      items.push({
        contentHash: candidate.contentHash,
        status: "blocked",
        reason: "below_threshold",
      });
      continue;
    }
    const r = await tx.promote({
      candidate,
      approvalRequestId: req.id,
      approvedByUserId: decidedByUserId,
    });
    if (r.written) {
      approved += 1;
      items.push({
        contentHash: candidate.contentHash,
        status: "promoted",
        verifiedId: r.verifiedId,
      });
    } else {
      duplicate += 1;
      items.push({
        contentHash: candidate.contentHash,
        status: "duplicate",
        verifiedId: r.verifiedId,
      });
    }
  }
  return { approved, duplicate, blocked, items };
}

// ── hash-chained, tamper-evident audit (10 §7) — append-only alone is not tamper-evident [S91] ─────────
export interface AuditRowInput {
  action: string;
  actorKind: "human" | "worker" | "ai";
  actorId: string;
  payload: unknown;
}

export function canonicalizeAuditRow(row: AuditRowInput): string {
  return JSON.stringify({
    action: row.action,
    actorKind: row.actorKind,
    actorId: row.actorId,
    payload: row.payload,
  });
}

/** row_hash = H(prev_hash ‖ canonical(row)) (10 §7 [S91]). */
export function forgeAuditHash(prevHash: string, canonical: string): string {
  return createHash("sha256").update(`${prevHash}\n${canonical}`).digest("hex");
}

/** Verify an audit chain end-to-end: each row's hash must equal H(prev ‖ canonical). */
export function verifyAuditChain(
  rows: Array<{ prevHash: string; rowHash: string; canonical: string }>,
): boolean {
  return rows.every((r) => forgeAuditHash(r.prevHash, r.canonical) === r.rowHash);
}
