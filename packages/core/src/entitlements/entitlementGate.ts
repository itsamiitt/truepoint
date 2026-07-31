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
import type { Tx } from "@leadwolf/db";
import { isFlagEnabledForTenant } from "../feature-flags/flagsForTenant.ts";

/** The per-tenant flag seeded (off) by migration 0088. */
export const ENTITLEMENTS_ENFORCED_FLAG_KEY = "entitlements_enforced";

/**
 * Evaluate the enforce half INSIDE an existing tenant tx. Env layer off ⇒ false with zero queries.
 *
 * IN-TX ONLY, and there is deliberately no `...ForScope` sibling opening its own transaction. The channel gate
 * has both because both have real callers; the only consumer here is the API middleware, which already opens
 * one transaction for the grants and the usage count, so a second variant would exist purely to let a caller
 * spend an extra round-trip on the reveal money endpoint. Fifteen lines to add back when something genuinely
 * needs it — an exported function with no caller is a working path nobody exercises.
 *
 * Does NOT catch: a flag read that fails inside a transaction must propagate with it. Catching here would
 * swallow the error and then keep issuing statements on an aborted transaction, which is the failure the
 * channel gate's in-tx variant documents too. The middleware's own try/catch turns that into fail-open, and
 * fail-open and fail-to-shadow both mean "allow the request", so the outcome is the same either way.
 */
export async function isEntitlementEnforced(tx: Tx, tenantId: string): Promise<boolean> {
  if (!env.ENTITLEMENTS_ENABLED) return false;
  return isFlagEnabledForTenant(tx, tenantId, ENTITLEMENTS_ENFORCED_FLAG_KEY);
}
