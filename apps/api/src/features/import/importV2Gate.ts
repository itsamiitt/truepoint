// importV2Gate.ts — the ONE evaluator of the import-v2 dual gate for the api surface (import-redesign 08
// §Rollout, 15 §R-P1): effective v2 = env.IMPORT_V2_ENABLED (global kill-switch, explicit-"true"-only) AND
// the per-tenant `import_v2_enabled` feature flag (seeded off in 0054; fail-closed evaluator — unknown/
// unreadable flag ⇒ off ⇒ legacy behavior, never an error page). Mirrors the jobViewer.ts dual-gate shape
// (S-V3, the house precedent): while the ENV layer is off this performs ZERO queries, so the flag-off
// request is cost-identical as well as byte-identical (T1 parity). Routes call this once per request and
// fork; the legacy branch is the shipped code, untouched — flipping either layer off at any point is the
// instant rollback lever (executed imports keep their durable rows; data is never rolled back by a flag).

import { env } from "@leadwolf/config";
import { isFlagEnabledForTenant } from "@leadwolf/core";
import { withTenantTx } from "@leadwolf/db";
import { IMPORT_V2_FLAG_KEY } from "@leadwolf/types";

/** Evaluate the dual gate for a tenant. Either layer off ⇒ false (legacy path, byte-identical). */
export async function isImportV2Enabled(tenantId: string): Promise<boolean> {
  // LAYER 1 — global env kill-switch: off ⇒ no flag read, no behavior change at all.
  if (!env.IMPORT_V2_ENABLED) return false;
  // LAYER 2 — per-tenant rollout flag (fail-closed: unknown flag evaluates off).
  return withTenantTx({ tenantId }, (tx) =>
    isFlagEnabledForTenant(tx, tenantId, IMPORT_V2_FLAG_KEY),
  );
}
