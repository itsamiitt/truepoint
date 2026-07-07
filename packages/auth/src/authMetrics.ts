// authMetrics.ts — dependency-free auth SLI counters (doc 03 §10 / doc 09, Phase 1 observability). This is the
// PRE-REQ for any enforcement flip: before turning a lockout-capable control on (require_sso, forced-MFA,
// IP-allowlist), on-call must be able to SEE login success/failure and policy-block rates. Mirrors
// apps/workers/src/metrics.ts exactly — an in-process counter registry + a hand-rolled Prometheus text renderer,
// zero-dep and scrapeable today; swapping in a real metrics client later replaces only renderAuthMetrics(), not
// the recordAuthMetric() call sites. Lives in packages/auth so apps/auth (the minter) and apps/api (the verifier)
// share one registry.
//
// PII RULE (enforced by the AuthMetricLabels types below): label VALUES are LOW-cardinality enums only —
// result / method / reason. NEVER a tenant id, user id, token, code, or raw IP. High-cardinality labels blow up
// the metrics store and can leak identity; those belong in the audit log (recordAuthEvent), not here.

/** The auth SLI counter names + their allowed label shape (kept bounded so cardinality can't explode). */
export interface AuthMetricLabels {
  auth_login_total: {
    result: "success" | "failure";
    method: "password" | "magic_link" | "sso" | "oauth" | "passkey";
  };
  auth_token_mint_total: { result: "success" | "failure" };
  auth_revocation_check_total: { result: "allowed" | "revoked" | "degraded" };
  /** An enforcement gate blocked a login (which control) — the number to watch when flipping a control on. */
  auth_policy_block_total: { reason: "mfa" | "method" | "ip" | "sso" | "session" | "idle" };
  auth_mfa_challenge_total: { result: "passed" | "failed" };
}
export type AuthMetricName = keyof AuthMetricLabels;

const counters = new Map<string, number>();

/** Prometheus series key: `name{k="v",...}` with labels sorted so the same label set always maps to one series. */
function seriesKey(name: string, labels: Record<string, string>): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  return parts.length > 0 ? `${name}{${parts.join(",")}}` : name;
}

/** Increment an auth SLI counter by one. The label shape is type-checked per metric, so a high-cardinality or
 *  PII label can't be passed by accident. */
export function recordAuthMetric<N extends AuthMetricName>(
  name: N,
  labels: AuthMetricLabels[N],
): void {
  const key = seriesKey(name, labels as Record<string, string>);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

/** Render the current counters as Prometheus exposition text, sorted for a stable scrape output. Per-process
 *  (reset on restart) — correct Prometheus counter semantics (collectors rate() over restarts). */
export function renderAuthMetrics(): string {
  return [...counters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key} ${value}`)
    .join("\n");
}

/** Test-only: clear the registry between cases (the module singleton persists across a process otherwise). */
export function __resetAuthMetrics(): void {
  counters.clear();
}
