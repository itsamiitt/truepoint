// deltaImportsGate.ts — the P5 DELTA-imports DUAL-GATE evaluator (import-and-data-model-redesign 08 §9 layer 3;
// 14 Phase 5 "external_id delta"). Mirrors scheduledImportGate.ts / channelDualWrite.ts EXACTLY — a
// fail-closed evaluator over the `DELTA_IMPORTS_ENABLED` env kill-switch AND the per-tenant
// `delta_imports_enabled` feature flag (seeded off in migration 0068):
//   effective = env.DELTA_IMPORTS_ENABLED (global kill-switch, explicit-"true"-only)
//               AND the per-tenant `delta_imports_enabled` flag (unknown/unreadable ⇒ off).
// While the ENV layer is off this performs ZERO queries, so a gate-off world evaluates nothing (the api route
// short-circuits and never carries the `externalIdUpsert` option onto the job payload). The FLAG layer is
// evaluated in its own scoped tx.
//
// This gate is the SECOND of THREE delta layers: the third is the per-import `externalIdUpsert` opt-in (a
// mapped `externalId` column). All three must be on before the caller's external key becomes the top dedup
// rung; any off ⇒ the shipped email→linkedin→sales-nav ladder, byte-identical (the engine never reads or
// writes contacts.external_id).

import { env } from "@leadwolf/config";
import { type Tx, withTenantTx } from "@leadwolf/db";
import { DELTA_IMPORTS_FLAG_KEY } from "@leadwolf/types";
import { isFlagEnabledForTenant } from "../featureFlags/flagsForTenant.ts";

/** Evaluate the delta dual gate INSIDE an existing tenant tx. Env layer off ⇒ false with zero queries. A
 *  flag-read failure propagates with the caller's tx (never catch inside a possibly-aborted tx). */
export async function isDeltaImportsEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  if (!env.DELTA_IMPORTS_ENABLED) return false;
  return isFlagEnabledForTenant(tx, tenantId, DELTA_IMPORTS_FLAG_KEY);
}

/** Evaluate the delta dual gate ONCE in its own scoped tx (the api route's pre-enqueue check). FAIL-CLOSED on
 *  error: a flag-read hiccup reads as OFF (the delta option is ignored, the shipped ladder runs) rather than
 *  half-admitting an external-id upsert. Env off ⇒ false with zero queries (the byte-identity short-circuit). */
export async function deltaImportsEnabledForScope(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<boolean> {
  if (!env.DELTA_IMPORTS_ENABLED) return false;
  try {
    return await withTenantTx(scope, (tx) =>
      isFlagEnabledForTenant(tx, scope.tenantId, DELTA_IMPORTS_FLAG_KEY),
    );
  } catch (err) {
    console.error("[delta-imports] flag read failed; treating as disabled (fail-closed)", err);
    return false;
  }
}
