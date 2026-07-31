// requireEntitlement.ts — the tier-cap gate for metered endpoints (06-roadmap Phase 1: "Free caps enforced").
// Applied AFTER authn/tenancy (it needs the scope) and BEFORE revealRateLimit and idempotency: a request the
// tenant may not make should not consume a rate-limit token, and must never reach the idempotency store — a
// refused attempt cached there would be replayed as a refusal after the tenant upgraded.
//
// TWO GATES, meaning different things (see core/entitlements/entitlementGate.ts):
//   env off          — pass-through, zero queries.
//   env on, flag off — SHADOW: compute and log the decision, never refuse. This is where the rollout sits
//                      while usage_event fills, since cap arithmetic reads that table and enforcing against an
//                      empty one would refuse nobody and prove nothing.
//   both on          — refuse.
// The plan's acceptance criterion is <1% shadow disagreement before any tenant flag flips; the log line below
// is that measurement.
//
// A CAP LAYER ABOVE CREDITS (decision D2): this never reads or writes a balance. Credits answer "what does it
// cost", entitlements answer "is it allowed at all". Reconciling the two in code is explicitly out of scope.

import { env } from "@leadwolf/config";
import {
  type EntitlementDecision,
  isEntitlementEnforced,
  periodFor,
  resolveEntitlement,
} from "@leadwolf/core";
import { entitlementRepository, withTenantTx } from "@leadwolf/db";
import { AppError } from "@leadwolf/types";
import type { Context, Next } from "hono";

/**
 * Guard one metered action behind its entitlement key.
 *
 * FAILS OPEN on an evaluation error, deliberately. This is a QUOTA gate, not an authorization boundary —
 * tenant isolation and ownership are enforced elsewhere by RLS and are unaffected by it. A database blip that
 * turned every reveal into a 402 would be a self-inflicted outage on the product's core action, while the
 * worst case of failing open is a tenant briefly exceeding a soft cap, which the credit balance still bounds
 * independently. Same reasoning as revealRateLimit failing open on a Redis outage.
 */
export function requireEntitlement(key: string) {
  return async function entitlementGuard(c: Context, next: Next): Promise<void> {
    if (!env.ENTITLEMENTS_ENABLED) return next();

    const tenantId = c.get("tenantId") as string | undefined;
    const workspaceId = c.get("workspaceId") as string | undefined;
    if (!tenantId || !workspaceId) return next(); // unscoped route — nothing to meter against

    let evaluated: { decision: EntitlementDecision; enforcing: boolean };
    try {
      evaluated = await evaluate({ tenantId, workspaceId }, key);
    } catch (err) {
      console.error("[entitlement] evaluation failed; allowing the request", { key, err });
      return next();
    }
    const { decision, enforcing } = evaluated;

    if (!enforcing) {
      if (!decision.allowed) {
        // The disagreement metric the rollout is gated on. Tenant id only — no user, no subject, no PII.
        console.info("[entitlement] shadow refusal", {
          key,
          tenantId,
          reason: decision.reason,
          cap: decision.cap,
          used: decision.used,
          source: decision.source,
        });
      }
      return next();
    }

    if (!decision.allowed) {
      // 402, not 429. "Your plan does not cover this" is a different instruction to a client than "slow down":
      // a 429 invites a retry that can never succeed until the plan changes.
      throw new AppError({
        status: 402,
        code: "entitlement_exceeded",
        title:
          decision.reason === "feature_disabled"
            ? "Feature not included in your plan"
            : "Plan limit reached",
        detail:
          decision.reason === "feature_disabled"
            ? "Your plan does not include this feature."
            : "You have reached your plan's limit for this period.",
        extensions: { entitlement: key, cap: decision.cap, used: decision.used },
      });
    }
    await next();
  };
}

/**
 * ONE scoped transaction for everything this middleware needs: the live grants, the usage counted against the
 * winning grant's period, and the enforce flag.
 *
 * Deliberately one and not two. The first version evaluated the decision and read the enforce flag through
 * separate helpers, each opening its own withTenantTx — two transactions per request on the reveal money
 * endpoint, largely to decide whether to print a log line. isEntitlementEnforced is the in-transaction variant
 * that exists precisely for this; the out-of-tx sibling was deleted rather than left exported with no caller.
 */
async function evaluate(
  scope: { tenantId: string; workspaceId: string },
  key: string,
): Promise<{ decision: EntitlementDecision; enforcing: boolean }> {
  return withTenantTx(scope, async (tx) => {
    const grants = await entitlementRepository.liveForTenant(tx, scope.tenantId);
    const used = await entitlementRepository.usedInPeriod(
      tx,
      scope.tenantId,
      key,
      periodFor(key, grants),
    );
    return {
      decision: resolveEntitlement(key, grants, used),
      enforcing: await isEntitlementEnforced(tx, scope.tenantId),
    };
  });
}
