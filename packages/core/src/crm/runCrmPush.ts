// runCrmPush.ts — the TP→CRM outbound push runner (crm-sync 00 §3.3 outbound / §6.2 / §8).
//
// One TP entity, one job. The pure decision (which fields may leave, and what the payload is) already lives
// in planCrmOutboundPush; this is the IO shell around it: gates, the suppression check, the content-hash
// short-circuit, the connector call, and the durable bookkeeping.
//
// THE GATE LADDER, checked in order and short-circuiting on the first refusal (00 §3.3 "GATES"):
//   L1 env CRM_SYNC_ENABLED   — the global kill switch; unset ⇒ the whole engine is dark.
//   L2 per-tenant flag        — crm_sync_enabled, fail-closed (an unknown tenant is OFF, not ON).
//   L3 connection sync_mode   — 'disabled' refuses; 'shadow' PLANS and RECORDS but performs no HTTP;
//                               only 'enforce' actually calls the CRM.
//   L4 per-field direction    — inside planCrmOutboundPush.
// The ladder is evaluated here rather than at the queue producer because a job can sit in Redis across a
// flag change: the operator who switches a tenant off expects the next job to stop, not the next enqueue.
//
// SHADOW IS NOT A NO-OP. It runs the whole pipeline, records the plan's counts and the content hash it
// WOULD have written, and skips only the HTTP call and the link mutation. That is what makes a dark launch
// informative — an operator can read crm_sync_runs and see exactly what enforce would have done. It is also
// why `mode` is snapshotted onto the run row: a shadow run's counts must never be mistaken for writes.
//
// SUPPRESSION IS CHECKED HERE, NOT ONLY IN THE PLANNER. The planner takes `suppressed` as an input, so a
// caller that forgot to look it up would get a clean plan for an erased subject. The lookup is part of the
// runner's contract for that reason (00 §6.5 / §7.6).

import type {
  CrmFieldMapping,
  CrmObjectType,
  CrmProvider,
  FieldProvenanceMap,
} from "@leadwolf/types";
import { planCrmOutboundPush } from "./planOutboundPush.ts";
import type { CrmConnector, CrmOutcome, CrmTokenBundle, CrmUpsertResult } from "./port.ts";

/** What the runner needs to read/write, injected so the runner itself stays testable without a database. */
export interface CrmPushDeps {
  /** Resolve the entity's pushable values + provenance. Returns null when the entity no longer exists. */
  loadEntity(): Promise<{
    values: Record<string, unknown>;
    provenance: FieldProvenanceMap;
  } | null>;
  /** The §6.5 suppression gate. True ⇒ the subject is erased/suppressed and NOTHING may be pushed. */
  isSuppressed(): Promise<boolean>;
  /** The existing link row, or null when this entity has never been pushed to this CRM. */
  loadLink(): Promise<{ id: string; crmRecordId: string; lastSyncedHash?: string | null } | null>;
  /** Enabled outbound mappings for this object type. */
  loadMappings(): Promise<CrmFieldMapping[]>;
  /** Decrypted bundle — only called when the ladder has already decided a real call will happen. */
  loadTokenBundle(): Promise<CrmTokenBundle>;
  /** Persist a successful push (link hash + last_outbound_at) and return the link id. */
  recordPushed(args: {
    crmRecordId: string;
    contentHash: string;
    operation: "create" | "update";
  }): Promise<void>;
  /** Accumulate counters on the run ledger. */
  addCounts(counts: Record<string, number>): Promise<void>;
}

export interface CrmPushGates {
  /** L1 — the env kill switch. */
  envEnabled: boolean;
  /** L2 — the per-tenant feature flag, already resolved fail-closed. */
  tenantFlagEnabled: boolean;
  /** L3 — the connection's mode at job time. */
  syncMode: "disabled" | "shadow" | "enforce";
}

export interface CrmPushInput {
  provider: CrmProvider;
  objectType: CrmObjectType;
  /** The TP entity id — used as the CRM external key so an upsert is idempotent across retries. */
  tpEntityId: string;
  externalIdField: string;
  gates: CrmPushGates;
  connector: CrmConnector;
  deps: CrmPushDeps;
}

export type CrmPushOutcomeKind =
  | "pushed" // an actual CRM write happened
  | "shadowed" // planned + recorded, no HTTP (sync_mode='shadow')
  | "skipped" // the planner had nothing to send, or the content hash was unchanged
  | "suppressed" // the subject is erased/suppressed — refused before anything else
  | "gated" // L1/L2/L3 refused
  | "missing" // the TP entity no longer exists
  | "rate_limited" // the CRM asked us to back off; the caller re-enqueues (NOT an attempt)
  | "failed";

export interface CrmPushResult {
  outcome: CrmPushOutcomeKind;
  operation?: "create" | "update" | "skip";
  contentHash?: string;
  fields?: string[];
  reason?: string;
  /** Set on rate_limited so the caller can delay the re-enqueue by the provider's own hint. */
  retryAfterMs?: number;
}

export async function runCrmPush(input: CrmPushInput): Promise<CrmPushResult> {
  const { gates, deps } = input;

  // ── L1 / L2 / L3 ────────────────────────────────────────────────────────────────────────────────────
  if (!gates.envEnabled) return { outcome: "gated", reason: "env_disabled" };
  if (!gates.tenantFlagEnabled) return { outcome: "gated", reason: "tenant_flag_off" };
  if (gates.syncMode === "disabled") return { outcome: "gated", reason: "connection_disabled" };

  // ── Suppression, before ANY read of the entity's field values ────────────────────────────────────────
  // Ordered first deliberately: an erased subject's values should not be loaded into memory to then be
  // discarded, and "we planned a push for a suppressed subject but didn't send it" is not a state worth
  // being able to reach.
  if (await deps.isSuppressed()) {
    await deps.addCounts({ recordsSkipped: 1 });
    return { outcome: "suppressed", reason: "subject_suppressed" };
  }

  const entity = await deps.loadEntity();
  if (!entity) {
    await deps.addCounts({ recordsSkipped: 1 });
    return { outcome: "missing", reason: "entity_gone" };
  }

  const [mappings, link] = await Promise.all([deps.loadMappings(), deps.loadLink()]);

  const plan = planCrmOutboundPush({
    provider: input.provider,
    mappings,
    values: entity.values,
    provenance: entity.provenance,
    link: link ? { lastSyncedHash: link.lastSyncedHash ?? null } : null,
    suppressed: false, // already refused above; passing the real value keeps the planner's own gate honest
  });

  // The content-hash short-circuit is the loop guard (§6.4): a record we just pushed, echoed back by the
  // CRM and re-queued, produces an identical hash and stops here instead of ping-ponging forever.
  if (plan.operation === "skip") {
    await deps.addCounts({ recordsSkipped: 1 });
    return {
      outcome: "skipped",
      operation: "skip",
      contentHash: plan.contentHash,
      reason: plan.reason ?? "nothing_to_push",
    };
  }

  // ── L3 shadow: everything except the write ──────────────────────────────────────────────────────────
  if (gates.syncMode === "shadow") {
    await deps.addCounts({ recordsSeen: 1, recordsSkipped: 1 });
    return {
      outcome: "shadowed",
      operation: plan.operation,
      contentHash: plan.contentHash,
      fields: plan.fields,
      reason: "shadow_mode",
    };
  }

  // ── enforce: the real call ──────────────────────────────────────────────────────────────────────────
  const bundle = await deps.loadTokenBundle();
  const outcome: CrmOutcome<{ perRecord: CrmUpsertResult[] }> = await input.connector.upsert({
    bundle,
    object: input.objectType,
    externalIdField: input.externalIdField,
    // The TP uuid IS the external key, which is what makes the upsert idempotent: a retried job after an
    // ambiguous timeout updates the same CRM record rather than creating a second one.
    records: [{ externalId: input.tpEntityId, values: plan.payload }],
  });

  await deps.addCounts({ apiCalls: 1, recordsSeen: 1 });

  if (outcome.kind === "rate_limited") {
    // NOT counted as an attempt or a failure: the provider told us to come back, and counting it would
    // make a healthy-but-throttled connection look like a failing one on the health surface.
    await deps.addCounts({ rateLimitedCt: 1 });
    return {
      outcome: "rate_limited",
      retryAfterMs: outcome.retryAfterMs,
      reason: outcome.daily ? "daily_cap" : "rate_limited",
    };
  }

  if (outcome.kind !== "ok") {
    await deps.addCounts({ recordsFailed: 1 });
    return { outcome: "failed", reason: outcome.kind };
  }

  const perRecord = outcome.value.perRecord[0];
  if (!perRecord || perRecord.outcome === "rejected") {
    await deps.addCounts({ recordsFailed: 1 });
    return { outcome: "failed", reason: "rejected_by_crm" };
  }

  await deps.recordPushed({
    crmRecordId: perRecord.externalId,
    contentHash: plan.contentHash,
    operation: plan.operation,
  });
  await deps.addCounts(
    perRecord.outcome === "created" ? { recordsCreated: 1 } : { recordsUpdated: 1 },
  );

  return {
    outcome: "pushed",
    operation: plan.operation,
    contentHash: plan.contentHash,
    fields: plan.fields,
  };
}
