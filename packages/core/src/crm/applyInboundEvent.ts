// applyInboundEvent.ts — the CRM→TruePoint apply runner (crm-sync 00 §3.3 inbound / §6.1).
//
// One CRM record, one job. planCrmInboundMerge already decides per field whether the CRM value may be
// written; this is the IO shell: the gates, the canonical re-fetch, the transform pass, identity
// resolution, the suppression wall, and the durable bookkeeping.
//
// THE RE-FETCH IS NOT OPTIONAL (00 §3.3). A webhook or CDC payload is a LOSSY DELTA — it names a record and
// a change, not the record's current state. Applying the payload directly would write a partial record and,
// worse, would apply whatever an attacker who forged a webhook chose to put in it. Re-fetching over the
// authenticated connection means the payload can only ever influence WHICH record we look at, never WHAT
// we write. That is why the signature takes an id, not a record body.
//
// THE SUPPRESSION WALL FACES INWARD HERE (00 §6.5 / §7.6). On the outbound path suppression stops us
// sending an erased subject to a CRM. On this path it stops the CRM RE-CREATING a subject the customer
// erased — the DSAR tombstone is worthless if the next sync tick pulls the person straight back in. The
// check therefore happens before any contact write, and refuses the whole record rather than a field.
//
// GATES: the same L1/L2/L3 ladder runCrmPush uses, evaluated in the runner for the same reason (a job can
// outlive a flag change). Shadow runs everything except the write, so an operator can see what enforce
// would have changed before flipping the connection.

import type {
  CrmFieldMapping,
  CrmObjectType,
  CrmProvider,
  FieldProvenanceMap,
} from "@leadwolf/types";
import { planCrmInboundMerge } from "./planInboundMerge.ts";
import type { CrmConnector, CrmTokenBundle } from "./port.ts";
import { type TransformConfig, transformInbound } from "./transforms.ts";

export interface CrmInboundDeps {
  /** Mapping rows for this object, with their transform config. */
  loadMappings(): Promise<Array<CrmFieldMapping & { transformConfig?: TransformConfig | null }>>;
  loadTokenBundle(): Promise<CrmTokenBundle>;
  /**
   * Resolve the CRM record to a TP entity: the link fast-path, then the dedup ladder.
   * `null` ⇒ no existing entity, so this is a create.
   */
  resolveEntity(args: {
    crmRecordId: string;
    values: Record<string, unknown>;
  }): Promise<{ entityId: string; linkId: string | null } | null>;
  /** The §6.5 suppression gate, evaluated against the INCOMING identity (blind index on email/phone). */
  isSuppressed(values: Record<string, unknown>): Promise<boolean>;
  /** Current TP values + provenance for an existing entity. */
  loadCurrent(entityId: string): Promise<{
    values: Record<string, unknown>;
    provenance: FieldProvenanceMap;
  }>;
  /** Persist the merge. Returns the entity id (minted when entityId is null). */
  persist(args: {
    entityId: string | null;
    values: Record<string, unknown>;
    provenance: FieldProvenanceMap;
  }): Promise<string>;
  /** Record the conflicts the planner routed to human review. */
  recordConflicts(
    entityId: string,
    conflicts: Array<{ tpField: string; tpValue: unknown; crmValue: unknown }>,
  ): Promise<void>;
  /** Upsert the external-id link + advance its inbound modstamp. */
  linkRecord(args: {
    entityId: string;
    crmRecordId: string;
    modstamp: Date | null;
  }): Promise<void>;
  addCounts(counts: Record<string, number>): Promise<void>;
}

export interface CrmInboundGates {
  envEnabled: boolean;
  tenantFlagEnabled: boolean;
  syncMode: "disabled" | "shadow" | "enforce";
}

export interface ApplyInboundEventInput {
  provider: CrmProvider;
  objectType: CrmObjectType;
  /** The CRM record id from the webhook/CDC hint. The ONLY thing the untrusted payload contributes. */
  crmRecordId: string;
  /** The CRM's own valid-time for this change, used as the provenance `obs` and the watermark candidate. */
  modstamp?: Date | null;
  /** The origin tag from the event, if the provider supplies one (the first loop guard, §6.6). */
  sourceTag?: string | null;
  /** Our own origin tag. An event carrying it is OUR write echoed back and is dropped. */
  ownSourceTag?: string | null;
  gates: CrmInboundGates;
  connector: CrmConnector;
  deps: CrmInboundDeps;
}

export type CrmInboundOutcomeKind =
  | "applied"
  | "created"
  | "shadowed"
  | "skipped"
  | "suppressed"
  | "gated"
  | "echo" // our own write, seen coming back
  | "not_found" // the CRM no longer has the record
  | "failed";

export interface ApplyInboundEventResult {
  outcome: CrmInboundOutcomeKind;
  entityId?: string;
  appliedFields?: string[];
  conflicts?: number;
  refusedFields?: Array<{ tpField: string; reason: string }>;
  reason?: string;
}

export async function applyInboundEvent(
  input: ApplyInboundEventInput,
): Promise<ApplyInboundEventResult> {
  const { gates, deps } = input;

  if (!gates.envEnabled) return { outcome: "gated", reason: "env_disabled" };
  if (!gates.tenantFlagEnabled) return { outcome: "gated", reason: "tenant_flag_off" };
  if (gates.syncMode === "disabled") return { outcome: "gated", reason: "connection_disabled" };

  // Loop guard 1 of 3 (§6.6): the origin tag. Cheapest and earliest — an echo of our own write is dropped
  // before we spend an API call re-fetching it. The other two guards (provenance `src` and the content
  // hash) sit further in, because they need the record.
  if (input.ownSourceTag && input.sourceTag && input.sourceTag === input.ownSourceTag) {
    await deps.addCounts({ recordsSkipped: 1 });
    return { outcome: "echo", reason: "own_origin_tag" };
  }

  // ── The canonical re-fetch. The payload named a record; the CONNECTION tells us what it contains. ────
  const bundle = await deps.loadTokenBundle();
  const fetched = await input.connector.fetchOne({
    bundle,
    object: input.objectType,
    externalId: input.crmRecordId,
  });
  await deps.addCounts({ apiCalls: 1, recordsSeen: 1 });

  if (fetched.kind !== "ok") {
    await deps.addCounts({ recordsFailed: 1 });
    return { outcome: "failed", reason: fetched.kind };
  }
  if (!fetched.value.record) {
    // Deleted between the event and the fetch. Not an error — the delete stream handles removal.
    await deps.addCounts({ recordsSkipped: 1 });
    return { outcome: "not_found", reason: "record_absent" };
  }

  const mappings = await deps.loadMappings();
  const { values: incomingValues, refused } = transformInbound(
    mappings.map((m) => ({
      tpField: m.tpField,
      crmField: m.crmField,
      transform: m.transform,
      transformConfig: m.transformConfig ?? null,
    })),
    fetched.value.record as Record<string, unknown>,
  );
  // Per-FIELD transform refusals are reported on the result (and land on the run row's failed_reason via
  // the caller) rather than counted as record-level failures: a record with one unparseable phone still
  // synced every other field, and counting it as failed would misreport a healthy connection.

  // ── The suppression wall, facing inward ─────────────────────────────────────────────────────────────
  // Checked on the INCOMING identity, before any resolution or write: an erased subject must not be
  // re-created by the next sync tick, or the DSAR tombstone means nothing.
  if (await deps.isSuppressed(incomingValues)) {
    await deps.addCounts({ recordsSkipped: 1 });
    return { outcome: "suppressed", reason: "subject_suppressed", refusedFields: refused };
  }

  const resolved = await deps.resolveEntity({
    crmRecordId: input.crmRecordId,
    values: incomingValues,
  });

  const current = resolved
    ? await deps.loadCurrent(resolved.entityId)
    : { values: {}, provenance: {} as FieldProvenanceMap };

  const plan = planCrmInboundMerge({
    provider: input.provider,
    mappings,
    incoming: Object.entries(incomingValues).map(([tpField, value]) => ({
      tpField,
      value,
      obs: input.modstamp ? input.modstamp.toISOString() : undefined,
    })),
    current: current.values,
    provenance: current.provenance,
    suppressed: false, // already refused above
  });

  if (plan.writableFields.size === 0 && plan.conflicts.length === 0) {
    await deps.addCounts({ recordsSkipped: 1 });
    return {
      outcome: "skipped",
      entityId: resolved?.entityId,
      reason: "no_writable_fields",
      refusedFields: refused,
    };
  }

  // ── shadow: everything except the write ─────────────────────────────────────────────────────────────
  if (gates.syncMode === "shadow") {
    await deps.addCounts({ recordsSkipped: 1, recordsConflicted: plan.conflicts.length });
    return {
      outcome: "shadowed",
      entityId: resolved?.entityId,
      appliedFields: [...plan.writableFields],
      conflicts: plan.conflicts.length,
      refusedFields: refused,
      reason: "shadow_mode",
    };
  }

  // ── enforce ─────────────────────────────────────────────────────────────────────────────────────────
  const isCreate = resolved === null;
  const entityId = await deps.persist({
    entityId: resolved?.entityId ?? null,
    values: plan.values,
    provenance: plan.provenance,
  });

  if (plan.conflicts.length > 0) {
    // Staged for review, never auto-resolved — the live value stays as it was (§6.1).
    await deps.recordConflicts(entityId, plan.conflicts);
  }

  await deps.linkRecord({
    entityId,
    crmRecordId: input.crmRecordId,
    modstamp: input.modstamp ?? null,
  });

  await deps.addCounts({
    ...(isCreate ? { recordsCreated: 1 } : { recordsUpdated: 1 }),
    ...(resolved ? { recordsMatched: 1 } : {}),
    ...(plan.conflicts.length ? { recordsConflicted: plan.conflicts.length } : {}),
  });

  return {
    outcome: isCreate ? "created" : "applied",
    entityId,
    appliedFields: [...plan.writableFields],
    conflicts: plan.conflicts.length,
    refusedFields: refused,
  };
}
