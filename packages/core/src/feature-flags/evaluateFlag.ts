// evaluateFlag.ts — the PURE flag-evaluation rule (13 §3.5, ADR-0011). No DB, no HTTP — given a flag's
// global state and an optional per-tenant override, decide whether the flag is on for that tenant.
//
// PRECEDENCE (per-tenant override else global default):
//   1. a per-tenant override (tenant_feature_flags.enabled) wins outright — on OR off;
//   2. else, if the flag is globally enabled (feature_flags.global_enabled) → on;
//   3. else, fall back to the flag's default (feature_flags.default);
//   4. an unknown flag (no definition) is OFF (fail-closed) — features are opt-in.

import type { FlagEvaluation, FlagEvaluationSource } from "@leadwolf/types";

/** The state needed to evaluate one flag for one tenant. `override` undefined = no per-tenant override. */
export interface FlagState {
  key: string;
  /** The global definition, or undefined when the flag is not defined at all. */
  definition?: {
    globalEnabled: boolean;
    defaultEnabled: boolean;
  };
  /** The tenant's override, if one is set. */
  override?: boolean;
}

/** Decide whether a flag is enabled for a tenant, with the source of the decision. */
export function evaluateFlag(state: FlagState): FlagEvaluation {
  if (state.override !== undefined) {
    return { key: state.key, enabled: state.override, source: "tenant_override" };
  }
  if (!state.definition) {
    // Unknown flag → fail closed (opt-in).
    return { key: state.key, enabled: false, source: "unknown" };
  }
  if (state.definition.globalEnabled) {
    return { key: state.key, enabled: true, source: "global" };
  }
  return {
    key: state.key,
    enabled: state.definition.defaultEnabled,
    source: "default" satisfies FlagEvaluationSource,
  };
}

/** Convenience boolean for code gates: `if (isFlagEnabled(state)) { … }`. */
export function isFlagEnabled(state: FlagState): boolean {
  return evaluateFlag(state).enabled;
}
