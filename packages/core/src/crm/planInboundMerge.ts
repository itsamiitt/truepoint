// planInboundMerge.ts — the PURE CRM→TruePoint merge planner (crm-sync §6.1). IO-free + non-mutating, so it
// unit-tests cleanly and converges on replay (the planFieldWrite posture, prospect/fieldProvenance.ts). It
// sits ALONGSIDE planFieldWrite (it does not modify it — enrichment depends on it) and adds direction +
// authority + a last-write-wins tiebreak + conflict→review on top of the existing pin gate. Per mapped
// incoming field it decides APPLY / SKIP / CONFLICT; the caller (applyInboundEvent, deferred) persists the
// writable values + the merged provenance + the conflict rows inside its own withTenantTx.

import {
  type CrmFieldMapping,
  type CrmProvider,
  type FieldProvenanceDescriptor,
  type FieldProvenanceMap,
  crmSrcFor,
} from "@leadwolf/types";

/** One mapped incoming CRM field (already transformed to the TP shape): value + confidence + valid-time. */
export interface InboundMergeField {
  tpField: string;
  value: unknown; // v_in
  conf?: number; // c_in ∈ [0,1]
  obs?: string; // t_in — the CRM record's modstamp (ISO valid-time)
}

export interface InboundMergeInput {
  provider: CrmProvider;
  mappings: CrmFieldMapping[];
  incoming: InboundMergeField[];
  /** Current TP values keyed by `tpField` (v_cur). */
  current: Record<string, unknown>;
  /** Current winning provenance descriptors (d) — the pin + valid-time inputs. */
  provenance: FieldProvenanceMap;
  /** The §6.5 suppression-gate result — true ⇒ refuse to apply anything (subject suppressed/erased). */
  suppressed: boolean;
}

export type CrmMergeDecision = "apply" | "skip" | "conflict";

export interface InboundFieldOutcome {
  tpField: string;
  decision: CrmMergeDecision;
  reason: string;
}

export interface InboundMergePlan {
  /** The `tpField`s that may actually be written. */
  writableFields: Set<string>;
  /** The new values to persist, keyed by `tpField` (only for APPLY fields). */
  values: Record<string, unknown>;
  /** The merged `field_provenance` map: existing descriptors + a fresh one per applied field. */
  provenance: FieldProvenanceMap;
  /** Fields that need human arbitration — the live field is NOT touched (staging-not-clobber, §6.1). */
  conflicts: Array<{ tpField: string; tpValue: unknown; crmValue: unknown }>;
  /** Per-field decision trace (observability). */
  outcomes: InboundFieldOutcome[];
}

/** Normalize for an equality (echo) compare — trim + lowercase strings; other types compare as-is. */
function norm(v: unknown): unknown {
  return typeof v === "string" ? v.trim().toLowerCase() : v;
}

/** A gap a TP-authoritative field may have filled from the CRM. */
function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** Epoch ms for an ISO time, or -Infinity when absent — the LWW tiebreak floor. */
function ms(iso?: string): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Decide one field, given its mapping + current value + descriptor (§6.1 ladder): an outbound/disabled field
 * is never applied inbound; an unchanged value is a no-op/echo; a PINNED field is a CONFLICT (never clobber a
 * human edit); otherwise — CRM-authoritative ⇒ apply, TP-authoritative ⇒ fill a gap only, authority unset ⇒
 * last-write-wins on valid-time.
 */
function decideField(
  f: InboundMergeField,
  m: CrmFieldMapping,
  current: Record<string, unknown>,
  d: FieldProvenanceDescriptor | undefined,
): CrmMergeDecision {
  if (m.direction === "outbound" || m.direction === "disabled") return "skip";
  if (norm(f.value) === norm(current[f.tpField])) return "skip";
  if (d?.pin === true) return "conflict";
  if (m.authority === "crm") return "apply";
  if (m.authority === "truepoint") return isBlank(current[f.tpField]) ? "apply" : "skip";
  return ms(f.obs) > ms(d?.obs ?? d?.at) ? "apply" : "skip"; // authority unset → LWW
}

/**
 * Plan the inbound merge. When `suppressed`, every field is skipped (the subject may not be (re)materialized,
 * §6.5). Otherwise each incoming field is mapped (unmapped/disabled → skip) and decided by `decideField`. An
 * APPLY stamps `{ src:"crm:<provider>", mth:"crm_sync", obs:t_in, conf:c_in, pin:false }`; a CONFLICT records
 * the pair and leaves the live field untouched. PURE — `current`/`provenance` are never mutated.
 */
export function planCrmInboundMerge(input: InboundMergeInput): InboundMergePlan {
  const writableFields = new Set<string>();
  const values: Record<string, unknown> = {};
  const provenance: FieldProvenanceMap = { ...input.provenance };
  const conflicts: InboundMergePlan["conflicts"] = [];
  const outcomes: InboundFieldOutcome[] = [];

  const byField = new Map(input.mappings.map((m): [string, CrmFieldMapping] => [m.tpField, m]));

  for (const f of input.incoming) {
    if (input.suppressed) {
      outcomes.push({ tpField: f.tpField, decision: "skip", reason: "suppressed" });
      continue;
    }
    const m = byField.get(f.tpField);
    if (!m || m.enabled === false) {
      outcomes.push({ tpField: f.tpField, decision: "skip", reason: "unmapped" });
      continue;
    }

    const decision = decideField(f, m, input.current, input.provenance[f.tpField]);
    if (decision === "apply") {
      writableFields.add(f.tpField);
      values[f.tpField] = f.value;
      provenance[f.tpField] = {
        src: crmSrcFor(input.provider),
        mth: "crm_sync",
        obs: f.obs,
        conf: f.conf,
        pin: false,
      };
    } else if (decision === "conflict") {
      conflicts.push({ tpField: f.tpField, tpValue: input.current[f.tpField], crmValue: f.value });
    }
    outcomes.push({ tpField: f.tpField, decision, reason: decision });
  }

  return { writableFields, values, provenance, conflicts, outcomes };
}
