// policy.ts — resolve the effective auth policy across tenant + workspace scopes, STRICTEST-WINS
// (ADR-0018). A workspace may only tighten the tenant policy, never relax it; MFA enforcement escalates.
// Phase 1 (doc 11 §3, doc 12) generalizes this to the platform → org → workspace chain via composeEffectivePolicy,
// and assembleScopePolicy maps the generic `auth_policies` (key, value jsonb) rows for one scope into a typed
// Partial<AuthPolicy> that the fold consumes.

import {
  type AuthMethod,
  type AuthPolicy,
  type MfaEnforcement,
  authPolicySchema,
} from "@leadwolf/types";

const MFA_RANK: Record<MfaEnforcement, number> = { off: 0, optional: 1, required: 2 };

/** The strictest of the supplied enforcement levels (a parent `required` always wins). */
export function strictestMfa(...levels: Array<MfaEnforcement | undefined>): MfaEnforcement {
  let acc: MfaEnforcement = "off";
  for (const l of levels) if (l && MFA_RANK[l] > MFA_RANK[acc]) acc = l;
  return acc;
}

// Allowlist intersection models "must satisfy both scopes"; an empty scope imposes no restriction.
function tighten(tenant: string[], workspace?: string[]): string[] {
  if (!workspace || workspace.length === 0) return tenant;
  if (tenant.length === 0) return workspace;
  return tenant.filter((c) => workspace.includes(c));
}

function intersectMethods(tenant: AuthMethod[], workspace?: AuthMethod[]): AuthMethod[] {
  return workspace ? tenant.filter((m) => workspace.includes(m)) : tenant;
}

function minDefined(a?: number, b?: number): number | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

/** Effective policy a login/refresh must satisfy. Booleans can only become more restrictive. */
export function resolveEffectivePolicy(
  tenant: AuthPolicy,
  workspace?: Partial<AuthPolicy>,
): AuthPolicy {
  return {
    mfaEnforcement: strictestMfa(tenant.mfaEnforcement, workspace?.mfaEnforcement),
    allowedMethods: intersectMethods(tenant.allowedMethods, workspace?.allowedMethods),
    disableSocial: tenant.disableSocial || (workspace?.disableSocial ?? false),
    requireSso: tenant.requireSso || (workspace?.requireSso ?? false),
    ipAllowlist: tighten(tenant.ipAllowlist, workspace?.ipAllowlist),
    sessionTimeoutSeconds: minDefined(
      tenant.sessionTimeoutSeconds,
      workspace?.sessionTimeoutSeconds,
    ),
    // Idle window is a timeout like the absolute cap: the strictest (shortest) of the two scopes wins.
    idleTimeoutSeconds: minDefined(tenant.idleTimeoutSeconds, workspace?.idleTimeoutSeconds),
    // Concurrent-session cap: a limit like the timeouts — the strictest (smallest) of the two scopes wins.
    maxConcurrentSessions: minDefined(
      tenant.maxConcurrentSessions,
      workspace?.maxConcurrentSessions,
    ),
  };
}

/** Whether a login method is permitted under the effective policy. */
export function isMethodAllowed(policy: AuthPolicy, method: AuthMethod): boolean {
  if (policy.requireSso && method !== "sso") return false;
  if (policy.disableSocial && method === "oauth") return false;
  return policy.allowedMethods.includes(method);
}

// Set-aware equality for a policy value: allowedMethods / ipAllowlist are unordered sets, everything else is a
// scalar compared by ===. Used only to detect whether the strictest-wins clamp changed a proposed value.
function samePolicyValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const bs = new Set(b);
    return a.every((x) => bs.has(x));
  }
  return a === b;
}

/**
 * AUTH-021 write-time guard — the security keys a proposed policy write may NOT loosen below `floor` (the
 * security MINIMUM: the env/code floor, or a staff-app hardening baseline). Reuses the strictest-wins resolver:
 * resolveEffectivePolicy(floor, proposed) CLAMPS any loosening back up to the floor, so any key whose clamped
 * value differs from what `proposed` asked for is a downgrade attempt. Returns the offending keys (empty = the
 * write is within the floor). Pure — the write path calls this BEFORE persisting and rejects a non-empty result,
 * so a config change can never create a vulnerability by loosening a security key below the minimum.
 */
export function findFloorViolations(
  proposed: Partial<AuthPolicy>,
  floor: AuthPolicy,
): Array<keyof AuthPolicy> {
  const clamped = resolveEffectivePolicy(floor, proposed);
  const violations: Array<keyof AuthPolicy> = [];
  for (const key of Object.keys(proposed) as Array<keyof AuthPolicy>) {
    if (!samePolicyValue(clamped[key], proposed[key])) violations.push(key);
  }
  return violations;
}

// ── Phase 1: the platform → org → workspace effective-policy engine (doc 11 §3, doc 12) ──────────────────────

/**
 * Fold an ordered scope chain into ONE effective policy, STRICTEST-WINS per key. The FIRST argument is the
 * COMPLETE platform default — the security floor (env-as-floor; doc 11 §3) — followed by the org override, then
 * the workspace override (each a Partial that only supplies the keys it sets). Each later scope may only TIGHTEN
 * a key, never loosen it: the reduction reuses the proven two-scope `resolveEffectivePolicy` pairwise, and its
 * per-key operations (MFA escalates, timeouts shorten, booleans OR, method/IP lists intersect) are all
 * associative + monotonic, so the strictest value across ALL scopes always survives regardless of fold order.
 */
export function composeEffectivePolicy(
  platformDefault: AuthPolicy,
  ...overrides: ReadonlyArray<Partial<AuthPolicy> | undefined>
): AuthPolicy {
  return overrides.reduce<AuthPolicy>(
    (acc, next) => (next ? resolveEffectivePolicy(acc, next) : acc),
    platformDefault,
  );
}

// The `auth_policies.key` → AuthPolicy field map, with a per-key parser for the jsonb `value`. This is the ONLY
// bridge between the generic (key, value) store and the typed policy; adding a knob = one entry here + the schema.
const POLICY_KEY_FIELD = {
  mfa_enforcement: "mfaEnforcement",
  allowed_methods: "allowedMethods",
  disable_social: "disableSocial",
  require_sso: "requireSso",
  ip_allowlist: "ipAllowlist",
  session_timeout_seconds: "sessionTimeoutSeconds",
  idle_timeout_seconds: "idleTimeoutSeconds",
  max_concurrent_sessions: "maxConcurrentSessions",
} as const satisfies Record<string, keyof AuthPolicy>;

// Reuse the field validators straight off authPolicySchema (the single source of truth in @leadwolf/types) so a
// value that would fail the tenant-editable PUT also fails here — no second, drifting copy of the rules.
const POLICY_KEY_PARSER = {
  mfa_enforcement: authPolicySchema.shape.mfaEnforcement,
  allowed_methods: authPolicySchema.shape.allowedMethods,
  disable_social: authPolicySchema.shape.disableSocial,
  require_sso: authPolicySchema.shape.requireSso,
  ip_allowlist: authPolicySchema.shape.ipAllowlist,
  session_timeout_seconds: authPolicySchema.shape.sessionTimeoutSeconds,
  idle_timeout_seconds: authPolicySchema.shape.idleTimeoutSeconds,
  max_concurrent_sessions: authPolicySchema.shape.maxConcurrentSessions,
} as const;

/**
 * Map the `auth_policies` rows for a SINGLE scope into a typed Partial<AuthPolicy>. Pure — the caller (the
 * repository) fetches the rows per scope, this shapes them, and composeEffectivePolicy folds the chain. An
 * unrecognised key is IGNORED (forward-compatible with knobs a newer writer added), and a value that fails its
 * parser is SKIPPED rather than throwing — a single malformed row must never break policy resolution (which
 * would fail login), so an unparseable override degrades to "not set" and the stricter parent scope stands.
 */
export function assembleScopePolicy(
  rows: ReadonlyArray<{ key: string; value: unknown }>,
): Partial<AuthPolicy> {
  const out: Partial<AuthPolicy> = {};
  for (const { key, value } of rows) {
    const field = POLICY_KEY_FIELD[key as keyof typeof POLICY_KEY_FIELD];
    const parser = POLICY_KEY_PARSER[key as keyof typeof POLICY_KEY_PARSER];
    if (!field || !parser) continue; // unknown key → ignore (future-proof)
    const parsed = parser.safeParse(value);
    if (parsed.success) (out as Record<string, unknown>)[field] = parsed.data; // malformed → skip, never throw
  }
  return out;
}

/**
 * Validate a single incoming policy-key WRITE (the write-path's value-shape guard; its floor guard is
 * findFloorViolations). Unlike assembleScopePolicy — which SKIPS a bad row during resolution so login never
 * breaks — a write must be REJECTED loudly so the caller returns a 422 rather than persisting garbage. Returns
 * the resolved AuthPolicy field name + the parsed value on success, or a typed reason on failure. Pure; reuses
 * the single-source-of-truth POLICY_KEY_PARSER.
 */
export function parsePolicyKeyValue(
  key: string,
  value: unknown,
):
  | { ok: true; field: keyof AuthPolicy; value: AuthPolicy[keyof AuthPolicy] }
  | { ok: false; reason: "unknown_key" | "invalid_value" } {
  const field = POLICY_KEY_FIELD[key as keyof typeof POLICY_KEY_FIELD];
  const parser = POLICY_KEY_PARSER[key as keyof typeof POLICY_KEY_PARSER];
  if (!field || !parser) return { ok: false, reason: "unknown_key" };
  const parsed = parser.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "invalid_value" };
  return { ok: true, field, value: parsed.data as AuthPolicy[keyof AuthPolicy] };
}

/** The write-authorization decision for one policy key: the validated field+value to persist, or a typed
 *  rejection the endpoint maps to a status (unknown_key / invalid_value → 422; below_floor → 403). */
export type PolicyWriteDecision =
  | { ok: true; field: keyof AuthPolicy; value: AuthPolicy[keyof AuthPolicy] }
  | {
      ok: false;
      reason: "unknown_key" | "invalid_value" | "below_floor";
      violations?: Array<keyof AuthPolicy>;
    };

/**
 * The COMPLETE write-authorization decision for one policy key — the write path's single pure security gate.
 * Composes both guards: (1) the value must be a known key with a well-typed value (parsePolicyKeyValue), and
 * (2) it must not loosen that key below the security `floor` (findFloorViolations, AUTH-021). Returns the
 * validated {field, value} to persist, or a typed rejection. Pure — the endpoint resolves the `floor` (the
 * PARENT scope's effective policy: for an org write that is the platform default; for a platform write, the
 * env/code minimum) and calls this BEFORE effectivePolicyRepository.upsertTenantKey.
 */
export function validatePolicyWrite(
  key: string,
  value: unknown,
  floor: AuthPolicy,
): PolicyWriteDecision {
  const parsed = parsePolicyKeyValue(key, value);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  // Single-key partial; the computed-key object needs the cast (TS widens `{[k]: v}` to a string index).
  const proposed = { [parsed.field]: parsed.value } as Partial<AuthPolicy>;
  const violations = findFloorViolations(proposed, floor);
  if (violations.length > 0) return { ok: false, reason: "below_floor", violations };
  return { ok: true, field: parsed.field, value: parsed.value };
}

/** One stored effective-policy row — the shape the repository returns (the value is raw jsonb, hence unknown). */
export interface AuthPolicyRow {
  scope: string; // 'platform' | 'org' | 'workspace'
  workspaceId: string | null;
  key: string;
  value: unknown;
}

/**
 * Resolve the effective policy for a (tenant, workspace) from the raw `auth_policies` rows the tenant can SEE —
 * its own rows plus the platform-NULL defaults (RLS guarantees no OTHER tenant's rows ever reach here). Pure:
 * the repository supplies `rows` + the hardcoded `floor`; this does no I/O.
 *
 * Composition model (doc 11 §3): the PLATFORM rows OVERRIDE the `floor` to form the platform default — the
 * platform admin *sets* the baseline, so this layer is a plain override (a platform row of `off` really means
 * off) — and then the ORG rows, then the MATCHING WORKSPACE's rows, can only TIGHTEN it (strictest-wins). A
 * tenant with several workspaces sees all their rows via RLS, so we filter to the requested `workspaceId`; with
 * no workspace in scope, workspace rows are ignored.
 */
export function resolvePolicyFromRows(
  rows: ReadonlyArray<AuthPolicyRow>,
  workspaceId: string | undefined,
  floor: AuthPolicy,
): AuthPolicy {
  const platform = rows.filter((r) => r.scope === "platform");
  const org = rows.filter((r) => r.scope === "org");
  const workspace = workspaceId
    ? rows.filter((r) => r.scope === "workspace" && r.workspaceId === workspaceId)
    : [];
  const platformDefault: AuthPolicy = { ...floor, ...assembleScopePolicy(platform) };
  return composeEffectivePolicy(
    platformDefault,
    assembleScopePolicy(org),
    assembleScopePolicy(workspace),
  );
}
