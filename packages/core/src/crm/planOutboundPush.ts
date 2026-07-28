// planOutboundPush.ts — the PURE TruePoint→CRM push planner (crm-sync §6.2). IO-free: same input → same
// output, no mutation of arguments, so it unit-tests cleanly and converges on replay (the planFieldWrite
// posture, prospect/fieldProvenance.ts). It decides, per the per-field mapping config + the winning
// provenance descriptor, which TP fields may flow OUT to a CRM, then whether the record is a create / an
// update / a skip. The caller (runCrmPush, deferred) does the IO: suppression lookup, the upsert, the link
// write. Loop prevention is built in: the provenance `src` label is the per-field echo guard (§6.6.2) and
// the content hash short-circuits an unchanged record (§6.4 L3).

import { createHash } from "node:crypto";
import {
  type CrmFieldMapping,
  type CrmProvider,
  type FieldProvenanceMap,
  crmSrcFor,
} from "@leadwolf/types";

export interface OutboundPushInput {
  /** This connection's CRM — used for the per-field echo guard (`src` starts with `crm:<provider>`). */
  provider: CrmProvider;
  /** The outbound-relevant per-field mapping rows for this object. */
  mappings: CrmFieldMapping[];
  /** Current TP values keyed by `tpField`. */
  values: Record<string, unknown>;
  /** The current winning provenance descriptor per `tpField` (gives `src` + `conf`). */
  provenance: FieldProvenanceMap;
  /** The existing `crm_record_links` row (null when this entity has never been pushed → create). */
  link: { lastSyncedHash?: string | null } | null;
  /** The §6.5 suppression-gate result — true ⇒ refuse to push (the subject is suppressed/erased). */
  suppressed: boolean;
}

export type CrmPushOperation = "create" | "update" | "skip";

export interface OutboundPushPlan {
  operation: CrmPushOperation;
  /** The `tpField`s that will be pushed. */
  fields: string[];
  /** The CRM-field → value payload to upsert (transforms are applied by the adapter/runner). */
  payload: Record<string, unknown>;
  /** sha256 of the canonical payload — recorded as `last_synced_hash`; the unchanged short-circuit key. */
  contentHash: string;
  /** Why the plan skipped (observability); set only when `operation === "skip"`. */
  reason?: string;
}

/** A value worth pushing — undefined/null are gaps we never push (clearing a CRM field is destructive). */
function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/** Stable sha256 over the sorted payload — order-independent, so a key reshuffle is not a false change. */
function hashPayload(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(payload)
      .sort()
      .map((k) => [k, payload[k]]),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const skip = (reason: string): OutboundPushPlan => ({
  operation: "skip",
  fields: [],
  payload: {},
  contentHash: "",
  reason,
});

/**
 * Plan the outbound push. Per field (§6.2): drop inbound/disabled-direction fields; drop CRM-authoritative
 * fields (the CRM is master); drop a field whose winning `src` is THIS CRM (echo guard); drop a field below
 * its confidence threshold. The surviving fields form the payload. Then: suppressed → skip; nothing to push
 * → skip; the content hash equals the last synced hash → skip (unchanged); otherwise create (no link) or
 * update (link exists). PURE — `values`/`provenance`/`link` are never mutated.
 */
export function planCrmOutboundPush(input: OutboundPushInput): OutboundPushPlan {
  if (input.suppressed) return skip("suppressed");

  const echoPrefix = crmSrcFor(input.provider);
  const fields: string[] = [];
  const payload: Record<string, unknown> = {};

  for (const m of input.mappings) {
    if (m.enabled === false) continue;
    if (m.direction === "inbound" || m.direction === "disabled") continue; // never push inbound-only
    if (m.authority === "crm") continue; // the CRM is the system of record for this field
    const value = input.values[m.tpField];
    if (!hasValue(value)) continue; // a gap — nothing to write

    const descriptor = input.provenance[m.tpField];
    if (descriptor?.src.startsWith(echoPrefix)) continue; // value CAME from this CRM → never push back
    const conf = descriptor?.conf ?? 1;
    if (conf < (m.confThreshold ?? 0)) continue; // don't pollute the CRM with low-confidence enrichment

    fields.push(m.tpField);
    payload[m.crmField] = value;
  }

  if (fields.length === 0) return skip("no_pushable_fields");

  const contentHash = hashPayload(payload);
  if (input.link && input.link.lastSyncedHash === contentHash) {
    return { operation: "skip", fields: [], payload: {}, contentHash, reason: "unchanged" };
  }

  return { operation: input.link ? "update" : "create", fields, payload, contentHash };
}
