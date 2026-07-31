// resolveEntitlement.ts — PURE resolution of "may this tenant do this, right now" (06-roadmap Phase 1:
// "Free caps enforced"). No IO: the caller loads the live rows and the period usage, this decides.
//
// A CAP LAYER ABOVE CREDITS, never a replacement (decision D2). Credits remain the internal settlement unit
// and answer "what does this cost". Entitlements answer "is this allowed at all, this period". The two are
// deliberately never reconciled in code, so nothing here reads or writes a balance.
//
// THE MERGE RULE IS MOST-PERMISSIVE-WINS, and the reason is Phase 3 rather than generosity. The Community tier
// grants expanded caps for keeping a contribution channel active; those rows coexist with the plan's own row
// for the same key (which is why `source` is in the primary key). When Community lapses, its row expires and
// the plan's cap reappears untouched — no recompute, no risk of a withdrawal clobbering what was paid for.
// Taking the maximum is what makes that expiry safe.

/** One live entitlement row. `cap: null` = unlimited; `cap: 0` = the feature is off for this tenant. */
export interface EntitlementGrant {
  key: string;
  cap: number | null;
  period: string | null;
  source: string;
}

export interface EntitlementDecision {
  /** Whether the action may proceed. */
  allowed: boolean;
  /** The effective cap that decided it — null when unlimited, absent when no grant covers the key. */
  cap: number | null;
  /** Usage counted against that cap this period. */
  used: number;
  /** Which source supplied the winning cap — for the "why" in a 402/429 body and in shadow-mode logs. */
  source: string | null;
  /** Set when the answer is a refusal, so the caller need not re-derive it. */
  reason?: "cap_reached" | "feature_disabled" | "no_entitlement";
}

/**
 * Decide one action against the live grants.
 *
 * FAIL-OPEN WHEN NO GRANT COVERS THE KEY, and this is deliberate, not an oversight. Phase 1 seeds entitlement
 * rows for nothing — the table ships empty — so a fail-CLOSED default would take every metered action in the
 * product offline the moment ENTITLEMENTS_ENABLED flipped, for every tenant at once. An unconfigured cap means
 * "nobody has expressed a limit", which is not the same as "the limit is zero". Once the plan sync populates
 * rows, absence stops occurring and the distinction stops mattering; until then this is the only default that
 * cannot cause an outage. The refusal reason is still reported so shadow mode can show how often it happens.
 */
export function resolveEntitlement(
  key: string,
  grants: readonly EntitlementGrant[],
  used: number,
): EntitlementDecision {
  const relevant = grants.filter((g) => g.key === key);
  if (relevant.length === 0) {
    return { allowed: true, cap: null, used, source: null, reason: "no_entitlement" };
  }

  // Unlimited beats any number, so it is checked before the numeric maximum — Math.max over nulls would
  // silently treat "unlimited" as 0.
  const unlimited = relevant.find((g) => g.cap === null);
  if (unlimited) return { allowed: true, cap: null, used, source: unlimited.source };

  let winner = relevant[0] as EntitlementGrant;
  for (const g of relevant) {
    if ((g.cap ?? 0) > (winner.cap ?? 0)) winner = g;
  }
  const cap = winner.cap ?? 0;

  // cap 0 is a real, expressible state: the feature is off for this tenant. Reported distinctly from
  // "you have used your allowance", because the two need different copy and different upsell.
  if (cap === 0) {
    return { allowed: false, cap: 0, used, source: winner.source, reason: "feature_disabled" };
  }
  return used >= cap
    ? { allowed: false, cap, used, source: winner.source, reason: "cap_reached" }
    : { allowed: true, cap, used, source: winner.source };
}

/** The period to count usage over for a key, given its live grants — the winning row's period. */
export function periodFor(key: string, grants: readonly EntitlementGrant[]): string | null {
  const relevant = grants.filter((g) => g.key === key);
  if (relevant.length === 0) return null;
  // Prefer an explicit period over a null one: a lifetime/unset grant must not silently widen the window a
  // monthly grant defined.
  return relevant.find((g) => g.period != null)?.period ?? null;
}
