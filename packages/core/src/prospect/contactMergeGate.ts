// contactMergeGate.ts — the S-C3 contact-merge dual-gate evaluator (import-and-data-model-redesign 04 §3.1;
// 15 §M-SEQ seq 62). The ONE decision the merge verb (Surface 2) and the Surface-1 staff wrapper consult
// before constructing the merge engine.
//
// THE GATE (dual, fail-closed — the channelDualWrite.ts / importV2Gate.ts precedent): effective merge =
//   env.CONTACT_MERGE_ENABLED  (global kill-switch, explicit-"true"-only — the name doc 04 pins)
//   AND the per-tenant `contact_merge_enabled` feature flag (seeded off in 0067).
// While the ENV layer is off this performs ZERO queries, so a gate-off request is cost-identical as well as
// behavior-identical (the verb 404s, the engine is never built — 04 §pre-build rollback). Unknown/unreadable
// flag ⇒ off (fail-closed via evaluateFlag). Merge is IRREVERSIBLE: flipping either half off halts NEW merges
// but never rolls back executed ones (04 §3.6 — guardrail, not unmerge).

import { env } from "@leadwolf/config";
import { type Tx, withTenantTx } from "@leadwolf/db";
import { CONTACT_MERGE_FLAG_KEY } from "@leadwolf/types";
import { isFlagEnabledForTenant } from "../featureFlags/flagsForTenant.ts";

/** Evaluate the S-C3 dual gate INSIDE an existing tenant tx. Env layer off ⇒ false with zero queries. A
 *  flag-read failure propagates with the caller's tx (never catch inside a possibly-aborted tx — the
 *  isChannelDualWriteEnabled posture). */
export async function isContactMergeEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  if (!env.CONTACT_MERGE_ENABLED) return false;
  return isFlagEnabledForTenant(tx, tenantId, CONTACT_MERGE_FLAG_KEY);
}

/** Evaluate the dual gate ONCE per request in its own scoped tx (the merge verb's pre-check before it opens
 *  the engine's tx). FAIL-CLOSED on error: a flag-read hiccup falls back to OFF (the verb 404s) — merge is
 *  destructive + irreversible, so a gate it cannot read is treated as closed, never open. */
export async function contactMergeEnabledForScope(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<boolean> {
  if (!env.CONTACT_MERGE_ENABLED) return false;
  try {
    return await withTenantTx(scope, (tx) => isContactMergeEnabled(tx, scope.tenantId));
  } catch (err) {
    console.error("[contact-merge] gate flag read failed; treating as OFF (fail-closed)", err);
    return false;
  }
}
