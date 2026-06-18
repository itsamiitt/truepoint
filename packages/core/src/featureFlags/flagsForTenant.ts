// flagsForTenant.ts — the flag-evaluation READ helper (13 §3.5, ADR-0011): resolve the on/off state of
// every (or one) flag for a tenant, applying the precedence in evaluateFlag (per-tenant override else
// global default). Runs INSIDE the caller's transaction so it inherits the right access path:
//   • in-app gating → call under withTenantTx({ tenantId }) — RLS exposes the global defs (read-only) and
//     this tenant's overrides only;
//   • admin preview  → call under withPlatformTx (owner) — same logic, cross-tenant visibility.
// Data access is the featureFlagRepository; the decision is the pure evaluateFlag rule. No HTTP.

import { type Tx, featureFlagRepository } from "@leadwolf/db";
import type { FlagEvaluation } from "@leadwolf/types";
import { evaluateFlag } from "./evaluateFlag.ts";

/** Evaluate EVERY defined flag for a tenant. Keyed result for easy `flags["bulk_enrich"].enabled` use. */
export async function evaluateFlagsForTenant(
  tx: Tx,
  tenantId: string,
): Promise<Record<string, FlagEvaluation>> {
  const [defs, overrides] = await Promise.all([
    featureFlagRepository.listGlobal(tx),
    featureFlagRepository.overridesForTenant(tx, tenantId),
  ]);
  const overrideByKey = new Map(overrides.map((o) => [o.flagKey, o.enabled]));

  const out: Record<string, FlagEvaluation> = {};
  for (const def of defs) {
    out[def.key] = evaluateFlag({
      key: def.key,
      definition: { globalEnabled: def.globalEnabled, defaultEnabled: def.defaultEnabled },
      override: overrideByKey.get(def.key),
    });
  }
  return out;
}

/** Evaluate a SINGLE flag for a tenant — the hot path for a code gate. Unknown flag → off (fail closed).
 *  Two PK/key lookups (the definition + the one override row), not a tenant-wide override scan. */
export async function evaluateFlagForTenant(
  tx: Tx,
  tenantId: string,
  key: string,
): Promise<FlagEvaluation> {
  const [def, override] = await Promise.all([
    featureFlagRepository.getGlobal(tx, key),
    featureFlagRepository.overrideFor(tx, key, tenantId),
  ]);
  return evaluateFlag({
    key,
    definition: def
      ? { globalEnabled: def.globalEnabled, defaultEnabled: def.defaultEnabled }
      : undefined,
    override: override ?? undefined,
  });
}

/** Boolean convenience for a single-flag gate. */
export async function isFlagEnabledForTenant(
  tx: Tx,
  tenantId: string,
  key: string,
): Promise<boolean> {
  return (await evaluateFlagForTenant(tx, tenantId, key)).enabled;
}
