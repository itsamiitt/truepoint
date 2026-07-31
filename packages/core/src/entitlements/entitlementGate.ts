// entitlementGate.ts — the S-10 dual-gate evaluator (the channelDualWrite.ts / importV2Gate.ts precedent).
//
// THE GATE:
//   env.ENTITLEMENTS_ENABLED (global kill-switch, explicit-"true"-only)
//   AND the per-tenant `entitlements_enforced` flag (seeded off in 0088)
//
// The two layers mean different things here, unlike the channel gate where both simply mean "on":
//   • env OFF          — the middleware is a pass-through. Zero queries, zero behaviour, nothing computed.
//   • env ON, flag OFF — SHADOW: the decision is computed and logged but never refuses. This is the state the
//                        rollout sits in while usage_event fills, because cap arithmetic reads that table and
//                        enforcing against an empty one proves nothing.
//   • both ON          — actually refuses.
//
// So a flag-read failure must resolve to SHADOW, not to enforce: an unreadable flag that silently started
// refusing paid requests is the one outcome worth engineering against.

import { env } from "@leadwolf/config";
import { type Tx, withTenantTx } from "@leadwolf/db";
import { isFlagEnabledForTenant } from "../feature-flags/flagsForTenant.ts";

/** The per-tenant flag seeded (off) by migration 0088. */
export const ENTITLEMENTS_ENFORCED_FLAG_KEY = "entitlements_enforced";

/** Evaluate the enforce half INSIDE an existing tenant tx. Env layer off ⇒ false with zero queries. */
export async function isEntitlementEnforced(tx: Tx, tenantId: string): Promise<boolean> {
  if (!env.ENTITLEMENTS_ENABLED) return false;
  return isFlagEnabledForTenant(tx, tenantId, ENTITLEMENTS_ENFORCED_FLAG_KEY);
}

/**
 * Evaluate the enforce half in its own scoped tx, for callers outside a transaction (the API middleware).
 * FAILS TO SHADOW on error — see the header: refusing a request because a flag could not be read would turn a
 * transient database blip into revenue-affecting downtime on the product's core action.
 */
export async function entitlementEnforcedForScope(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<boolean> {
  if (!env.ENTITLEMENTS_ENABLED) return false;
  try {
    return await withTenantTx(scope, (tx) =>
      isFlagEnabledForTenant(tx, scope.tenantId, ENTITLEMENTS_ENFORCED_FLAG_KEY),
    );
  } catch (err) {
    console.error("[entitlement] enforce-flag read failed; staying in shadow", err);
    return false;
  }
}
