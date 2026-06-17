// policy.ts — the auto-enrich policy ENFORCEMENT module (G-ENR-1; 29 §3, 06 §4.1). This is the guard the
// enrichment entry point consults BEFORE any auto-enrich (system-initiated) call. It does NOT touch the
// provider waterfall — it only decides, given a workspace's policy + current month spend, WHETHER auto-enrich
// may run and WHICH of the requested fields are permitted. Two layers:
//   • decideAutoEnrich(...)  — a PURE decision over an already-loaded policy (unit-testable, no I/O).
//   • enforceAutoEnrichPolicy(scope, ...) — loads the policy + month-to-date spend via the repository and
//     applies decideAutoEnrich. The enrichment entry point (enrichContact) calls this when invoked with an
//     auto-enrich `trigger`; a manual/user-initiated enrich (no trigger) bypasses the policy entirely.
// Off by default: an unconfigured workspace gets DEFAULT_ENRICHMENT_POLICY (disabled) so it never auto-enriches.

import { type TenantScope, enrichmentPolicyRepository } from "@leadwolf/db";
import type { EnrichField, EnrichTrigger, EnrichmentPolicy } from "@leadwolf/types";

/** Why auto-enrich was denied (null when allowed) — surfaced to the caller / logs, never thrown by the guard. */
export type AutoEnrichDenyReason =
  | "policy_disabled" // the workspace has not enabled auto-enrich
  | "trigger_not_allowed" // this trigger (e.g. on_import) is not in the policy's enabled triggers
  | "no_allowed_fields" // none of the requested fields are on the policy's allowlist
  | "budget_exhausted"; // the monthly budget cap is already reached, so no spend may start

export interface AutoEnrichDecisionInput {
  /** Which event is asking to auto-enrich. */
  trigger: EnrichTrigger;
  /** The fields the caller wants filled (the request fields). */
  requestedFields: EnrichField[];
  /** Month-to-date provider spend for the workspace, in micros (from the repository). */
  monthlySpentMicros: number;
}

export interface AutoEnrichDecision {
  /** True only when the policy permits this trigger, ≥1 requested field is allowed, AND budget remains. */
  allowed: boolean;
  /** The requested fields intersected with the policy allowlist (order preserved; empty when none match). */
  allowedFields: EnrichField[];
  /** The remaining monthly budget in micros (cap − spent, floored at 0). */
  remainingBudgetMicros: number;
  /** Set when `allowed` is false; null otherwise. */
  reason: AutoEnrichDenyReason | null;
}

/**
 * The PURE policy decision — no I/O, fully unit-testable. Order of checks (fail-closed, cheapest first):
 *   1. disabled → deny.
 *   2. trigger not in the enabled set → deny.
 *   3. none of the requested fields on the allowlist → deny (the allowlist BOUNDS the fill; an empty
 *      allowlist permits nothing).
 *   4. monthly budget already reached (spent ≥ cap) → deny (stop at the cap, 06 §4.1 / §6). A `0` cap
 *      therefore denies all auto-enrich spend.
 * When allowed, `allowedFields` is the requested set intersected with the allowlist (so the waterfall is
 * only ever asked for permitted fields) and `remainingBudgetMicros` is the headroom the caller may spend.
 *
 * NOTE — this is a non-reserving PRE-CHECK, mirroring the daily budget breaker in enrichContact (`spent >=
 * budget`): it stops the next run once the cap is reached, so a single run can finish slightly over the cap.
 * Hard reserve-then-spend (the credit lease) is owned by billing / the bulk pipeline (ADR-0029, 06 §4.1) and
 * is deliberately out of this guard's scope.
 */
export function decideAutoEnrich(
  policy: EnrichmentPolicy,
  input: AutoEnrichDecisionInput,
): AutoEnrichDecision {
  const remainingBudgetMicros = Math.max(0, policy.monthlyBudgetMicros - input.monthlySpentMicros);
  const allowlist = new Set<EnrichField>(policy.fieldAllowlist);
  const allowedFields = input.requestedFields.filter((f) => allowlist.has(f));

  if (!policy.enabled) {
    return { allowed: false, allowedFields: [], remainingBudgetMicros, reason: "policy_disabled" };
  }
  if (!policy.triggers.includes(input.trigger)) {
    return {
      allowed: false,
      allowedFields: [],
      remainingBudgetMicros,
      reason: "trigger_not_allowed",
    };
  }
  if (allowedFields.length === 0) {
    return {
      allowed: false,
      allowedFields: [],
      remainingBudgetMicros,
      reason: "no_allowed_fields",
    };
  }
  if (remainingBudgetMicros <= 0) {
    return {
      allowed: false,
      allowedFields,
      remainingBudgetMicros,
      reason: "budget_exhausted",
    };
  }
  return { allowed: true, allowedFields, remainingBudgetMicros, reason: null };
}

/**
 * Load the workspace's policy + month-to-date provider spend, then decide. An unconfigured workspace uses
 * DEFAULT_ENRICHMENT_POLICY (disabled) → denied. The repository reads are workspace-scoped (RLS). This is the
 * single seam the enrichment entry point calls before an auto-enrich run; it never calls a provider itself.
 * A scope with no workspaceId DENIES fail-closed (auto-enrich is per-workspace) rather than throwing, so an
 * unscoped caller can never bypass the policy.
 */
export async function enforceAutoEnrichPolicy(
  scope: TenantScope,
  input: { trigger: EnrichTrigger; requestedFields: EnrichField[] },
): Promise<AutoEnrichDecision> {
  if (!scope.workspaceId) {
    return {
      allowed: false,
      allowedFields: [],
      remainingBudgetMicros: 0,
      reason: "policy_disabled",
    };
  }
  const policy = await enrichmentPolicyRepository.resolved(scope);
  const monthlySpentMicros = await enrichmentPolicyRepository.monthlySpentMicros(scope);
  return decideAutoEnrich(policy, {
    trigger: input.trigger,
    requestedFields: input.requestedFields,
    monthlySpentMicros,
  });
}
