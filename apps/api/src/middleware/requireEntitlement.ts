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

import { guardDegradedLog, makeDegradedThrottle } from "@leadwolf/auth";
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
import { entitlementBasisCached } from "../lib/gateMemo.ts";

// Module-scoped throttle for the fail-open marker (audit 32 · C11) — see guardDegradedLog.ts.
const allowDegradedLog = makeDegradedThrottle();

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
      // Fail open — unchanged. What changed (audit 32 · C11) is the marker: this now carries the shared
      // `] DEGRADED ` shape so ONE alert expression catches every guard that opens, and two firing in the same
      // window is the composite condition the audit was actually worried about. Throttled, because during an
      // outage this runs per request. The entitlement `key` is dropped from the line deliberately — it is not
      // needed to page someone, and this fires at request rate.
      if (allowDegradedLog(Date.now())) console.error(guardDegradedLog("entitlement", err));
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
 * The BASIS (live grants + the enforce flag) is memoized 30s per tenant; USAGE is read live every request.
 *
 * The split follows what actually changes when (perf-audit P2.4): grants move on a plan override and the
 * enforce switch on an admin flag write — both of which invalidate the memo synchronously — while usage
 * moves on every metered action and is the one number this gate must never serve stale. The previous shape
 * ran grants + usage + enforce-flag in one transaction per request, re-reading monthly-stable rows on the
 * reveal money endpoint every single time. On a memo hit this is ONE transaction with ONE query (the usage
 * aggregate); the miss path (once per tenant per 30s, and after every invalidation) pays two transactions,
 * which is why the basis read is not folded into the usage transaction.
 */
async function evaluate(
  scope: { tenantId: string; workspaceId: string },
  key: string,
): Promise<{ decision: EntitlementDecision; enforcing: boolean }> {
  const basis = await entitlementBasisCached(scope.tenantId, () =>
    withTenantTx(scope, async (tx) => ({
      grants: await entitlementRepository.liveForTenant(tx, scope.tenantId),
      enforcing: await isEntitlementEnforced(tx, scope.tenantId),
    })),
  );
  const used = await withTenantTx(scope, (tx) =>
    entitlementRepository.usedInPeriod(tx, scope.tenantId, key, periodFor(key, basis.grants)),
  );
  return { decision: resolveEntitlement(key, basis.grants, used), enforcing: basis.enforcing };
}
