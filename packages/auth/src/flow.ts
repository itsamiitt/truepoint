// flow.ts — the login state machine after primary auth (17 §2). resolveNextStep decides MFA → org →
// workspace; finalizeLogin runs ONLY when all factors pass — it resolves the active org + workspace, opens
// the durable session (carrying that scope), and issues the single-use cross-domain code. (ADR-0019/0020.)

import { env } from "@leadwolf/config";
import {
  type TenantMembership,
  type WorkspaceSummary,
  authPolicyRepository,
  tenantMemberRepository,
  userRepository,
  workspaceRepository,
} from "@leadwolf/db";
import { ForbiddenError } from "@leadwolf/types";
import { recordAuthEvent } from "./auditEvent.ts";
import { recordAuthMetric } from "./authMetrics.ts";
import { issueCode } from "./code.ts";
import { isIpAllowed } from "./ipAllowlist.ts";
import { log } from "./log.ts";
import { type LoginTransaction, patchLoginTransaction } from "./loginTransaction.ts";
import { isMethodAllowed } from "./policy.ts";
import { shadowComparePolicy } from "./policyShadow.ts";
import { authorizeTenantSelection } from "./scopeGuard.ts";
import { createSession } from "./session.ts";

export type LoginStep = "mfa" | "mfa_enroll" | "org" | "workspace" | "complete";

// Same-request read cache: resolveNextStep already fetches the user's org list and (sometimes) the workspace
// list for the resolved tenant. finalizeLogin would otherwise re-query the identical rows a moment later in
// the same request. Stash those reads against the in-memory txn OBJECT (the SAME reference flows from
// resolveNextStep → finishLogin → finalizeLogin in every caller) so finalizeLogin can reuse them.
//
// Why a WeakMap and not a field on the txn: the txn is JSON-serialized into Redis (loginTransaction.ts), so a
// field would risk persisting a stale membership snapshot across the multi-step flow. The WeakMap is purely
// in-memory and per-object, so it NEVER persists and NEVER crosses a request — across requests (the org /
// workspace step runs against a fresh txn parsed from Redis) the hint is simply absent and finalizeLogin
// falls back to a fresh, authoritative read. The cache is a performance hint only: the authorization
// decisions in finalizeLogin (authorizeTenantSelection / the workspace-membership check) are UNCHANGED — they
// run over exactly the rows they would have re-fetched, against the same untrusted client selection.
interface ResolvedScope {
  orgs?: TenantMembership[];
  // Workspaces are tenant-scoped, so a cached list is keyed by the tenant it was read under.
  readonly workspacesByTenant: Map<string, WorkspaceSummary[]>;
}
const resolvedScope = new WeakMap<LoginTransaction, ResolvedScope>();

// One mutable per-request scope per txn object; created on first read, mutated in place thereafter. The login
// flow is strictly sequential within a request (resolveNextStep then finalizeLogin, each awaited), so there is
// no concurrent access to a single txn's scope.
function scopeFor(txn: LoginTransaction): ResolvedScope {
  let scope = resolvedScope.get(txn);
  if (!scope) {
    scope = { workspacesByTenant: new Map() };
    resolvedScope.set(txn, scope);
  }
  return scope;
}

async function getOrgs(txn: LoginTransaction): Promise<TenantMembership[]> {
  const scope = scopeFor(txn);
  if (scope.orgs) return scope.orgs;
  scope.orgs = await tenantMemberRepository.listForUser(txn.userId);
  return scope.orgs;
}

async function getWorkspaces(txn: LoginTransaction, tenantId: string): Promise<WorkspaceSummary[]> {
  const scope = scopeFor(txn);
  const cached = scope.workspacesByTenant.get(tenantId);
  if (cached) return cached;
  const ws = await workspaceRepository.listForUser(tenantId, txn.userId);
  scope.workspacesByTenant.set(tenantId, ws);
  return ws;
}

export async function resolveNextStep(txnId: string, txn: LoginTransaction): Promise<LoginStep> {
  // MFA: required when the user has a verified method enrolled (user opt-in). Tenant/workspace policy
  // enforcement layers on top once the policy repos are wired (ADR-0018). Read the verified-method state ONCE
  // here — both the existing "challenge an enrolled user" branch and the P1-01 forced-enrollment branch below
  // key off it (avoids a second listMfaMethods round-trip in the same request).
  let hasVerifiedMethod = false;
  if (!txn.mfaVerified) {
    const methods = await userRepository.listMfaMethods(txn.userId);
    hasVerifiedMethod = methods.some((m) => m.verifiedAt);
    if (hasVerifiedMethod) return "mfa";
  }

  // Org: pick when the identity belongs to >1 org; a single membership auto-selects (persisted, no UI step).
  let tenantId = txn.tenantId;
  if (!tenantId) {
    const orgs = await getOrgs(txn);
    if (orgs.length > 1) return "org";
    tenantId = orgs[0]?.tenantId;
    if (!tenantId) return "complete"; // no membership (edge) — finalizeLogin surfaces it
    await patchLoginTransaction(txnId, { tenantId });
  }

  // ── P1-01 sub-gate A — forced in-login MFA enrollment ────────────────────────────────────────────────
  // LOCKOUT-CAPABLE: enforced only when BOTH (a) the global env master-arm is the literal string "true" AND
  // (b) the resolved tenant's per-tenant enforcement switch is ON. With either off this block is skipped, so
  // resolveNextStep returns EXACTLY what it does today and an un-enrolled user under a required-MFA org falls
  // through to finalizeLogin, where the UNCHANGED ForbiddenError ("mfa_required") throw still fires — the
  // pre-existing fail-closed behavior is byte-for-byte preserved. The env check stays the OUTER guard so a
  // globally-disarmed deployment does NO policy read at all (today's behavior, zero extra round-trip).
  //
  // When both arms are on: when the RESOLVED tenant mandates MFA (`required`) and this not-yet-MFA-verified
  // user has NO verified method, route to the forced-enrollment step (apps/auth /mfa/enroll) instead of
  // erroring. The tenant is resolved above (auto-selected single org, or carried from the org-selection step)
  // so the policy is the right per-tenant one. finalizeLogin remains the authoritative token gate (it still
  // refuses to mint for an un-enrolled required user), so this is a UX route, never the security boundary.
  if (env.AUTH_POLICY_ENFORCEMENT_ENABLED === "true" && !txn.mfaVerified && !hasVerifiedMethod) {
    const { policy, enforcementEnabled } = await authPolicyRepository.getForEnforcement(tenantId);
    if (enforcementEnabled && policy.mfaEnforcement === "required") return "mfa_enroll";
  }

  // Workspace: a single one auto-selects. With several, land on the user's remembered workspace (where they
  // left off) instead of forcing a pick every login; only prompt when there is no valid remembered one (2c).
  if (!txn.workspaceId) {
    const ws = await getWorkspaces(txn, tenantId);
    if (ws.length > 1) {
      const last = await tenantMemberRepository.getLastWorkspace(tenantId, txn.userId);
      if (last && ws.some((w) => w.id === last)) {
        await patchLoginTransaction(txnId, { workspaceId: last });
        return "complete";
      }
      return "workspace";
    }
  }
  return "complete";
}

/** Defence-in-depth for the org-selection step: is this (client-supplied) org an ACTIVE membership of the
 *  user? Lets selectOrg reject a forged tenantId early with a graceful redirect — finalizeLogin remains the
 *  authoritative gate (it re-checks before minting the token). */
export async function isActiveTenantMember(userId: string, tenantId: string): Promise<boolean> {
  const orgs = await tenantMemberRepository.listForUser(userId);
  return orgs.some((o) => o.tenantId === tenantId);
}

/** Defence-in-depth for the workspace-selection step: is this (client-supplied) workspace an ACTIVE
 *  membership of the user within the tenant? (getRoleForUser is tenant-scoped, so a workspace in another
 *  tenant yields no membership.) */
export async function isActiveWorkspaceMember(
  userId: string,
  tenantId: string,
  workspaceId: string,
): Promise<boolean> {
  return (await workspaceRepository.getRoleForUser(tenantId, workspaceId, userId)) !== null;
}

export interface FinalizedLogin {
  code: string;
  refreshToken: string;
  refreshMaxAge: number;
  appOrigin: string;
  state: string;
}

export async function finalizeLogin(
  txn: LoginTransaction,
  ctx: { userAgent?: string },
): Promise<FinalizedLogin> {
  // Resolve + AUTHORIZE the active org and workspace. A client-supplied tenantId/workspaceId (from the
  // org/workspace selection steps) is UNTRUSTED: it must match an ACTIVE membership, or it is a forged
  // cross-tenant selection. The minted JWT's tid/wid drive the downstream RLS GUC, so an unvalidated
  // selection here is a cross-tenant breach — the same authorization switchWorkspace enforces. (Phase 0a.)
  //
  // getOrgs reuses the membership list resolveNextStep already read THIS request (same txn object), or reads
  // it fresh when finalizeLogin runs in a later request (the org/workspace step). Either way the list is the
  // user's REAL active memberships and authorizeTenantSelection is the unchanged authoritative gate.
  const orgs = await getOrgs(txn);
  const tenantId = authorizeTenantSelection(orgs, txn.tenantId);

  // MFA enforcement (ADR-0018): a tenant that MANDATES MFA must not complete login without it — fail closed
  // at the token gate. Enrolled users are already challenged earlier (resolveNextStep → "mfa", so mfaVerified
  // is true here); this blocks the un-enrolled case for a required-MFA org. Tenants on the default ("optional"
  // / "off") policy are unaffected.
  //
  // This throw is UNCHANGED and is the authoritative fail-closed backstop — it is NOT behind
  // AUTH_POLICY_ENFORCEMENT_ENABLED, so with the flag OFF behavior is byte-for-byte today's (an un-enrolled
  // required user is errored here). P1-01 sub-gate A added the better-UX path WITHOUT touching this throw:
  // when the flag is ON, resolveNextStep routes the same un-enrolled-required case to the "mfa_enroll" step
  // (→ apps/auth /mfa/enroll) BEFORE finalizeLogin runs, so the user enrolls (which sets mfaVerified) and this
  // block is then satisfied. If finalizeLogin is ever reached un-enrolled under a required policy (flag on or
  // off), this throw still fires — the token gate never mints for an un-enrolled required user.
  if (!txn.mfaVerified) {
    const policy = await authPolicyRepository.getForTenant(tenantId);
    if (policy.mfaEnforcement === "required") {
      throw new ForbiddenError(
        "mfa_required",
        "Your organization requires multi-factor authentication. Enroll a method to continue.",
      );
    }
  }

  // ── P1-01 tenant auth-policy enforcement (ADR-0018) ──────────────────────────────────────────────────
  // LOCKOUT-CAPABLE gates: enforced ONLY when BOTH the global env master-arm is the literal string "true" AND
  // the resolved tenant's per-tenant enforcement switch is ON. Either off = OFF = today's exact behavior (the
  // merge-safety guarantee — every gate below is inside the `enforcementEnabled` block, so with the flag off
  // NONE can fire). The env check stays the OUTER guard so a globally-disarmed deployment does no policy read.
  // The per-tenant switch is STAFF-set (default OFF), so after this change no tenant is enforced until a
  // platform super_admin explicitly enables it — strictly safer than the old global-only gate. Security ACs →
  // ../../Authentication plan/09-threat-model.md: the gate runs SERVER-SIDE here at finalizeLogin (the
  // authoritative token gate), over the RESOLVED tenant policy (never client input), after the tenant
  // membership is authorized above.
  //
  // Gate D — session timeout: the resolved cap (if any) is captured here and applied at createSession below
  // (the new session's absolute lifetime is min(default, cap)); the refresh path enforces the same absolute
  // cap to force re-auth. Stays undefined when enforcement is off → unchanged default session lifetime.
  let sessionMaxLifetimeSeconds: number | undefined;
  if (env.AUTH_POLICY_ENFORCEMENT_ENABLED === "true") {
    const { policy, enforcementEnabled } = await authPolicyRepository.getForEnforcement(tenantId);
    if (enforcementEnabled) {
      if (policy.sessionTimeoutSeconds != null && policy.sessionTimeoutSeconds > 0) {
        sessionMaxLifetimeSeconds = policy.sessionTimeoutSeconds;
      }

      // Gate C — IP allowlist. When the resolved tenant policy pins an allowlist, the client IP captured at
      // the start of THIS login transaction (txn.clientIp, server-observed, not client-supplied) must fall
      // inside at least one CIDR. Match by CIDR NETWORK, never string equality; a malformed entry fails closed
      // for that entry only (isIpAllowed skips it) — it never opens the gate. Empty allowlist = no restriction.
      const allowlist = policy.ipAllowlist ?? [];
      if (allowlist.length > 0 && !isIpAllowed(txn.clientIp, allowlist)) {
        recordAuthMetric("auth_policy_block_total", { reason: "ip" });
        throw new ForbiddenError(
          "ip_not_allowed",
          "Your organization restricts sign-in to approved networks. You are connecting from an address that is not on the allowlist.",
        );
      }

      // Gate B — allowed methods. The method used to open THIS login transaction (server-set at each edge:
      // password / magic_link / sso / signup→password — never a client value) must be permitted by the
      // resolved tenant policy. isMethodAllowed also folds in requireSso / disableSocial (strictest-wins,
      // policy.ts). FAIL-OPEN ON MISSING DATA: an empty allowedMethods imposes no restriction, and a
      // transaction with NO method (an older Redis row in flight across the deploy that added the field) is
      // NOT blocked — we never lock a user out over data we do not have. Only a present-and-disallowed method
      // fails closed.
      if (
        txn.method !== undefined &&
        policy.allowedMethods.length > 0 &&
        !isMethodAllowed(policy, txn.method)
      ) {
        // SLI: an enforcement gate blocked this login (which control) — the rate to watch when flipping a
        // control on. Low-cardinality reason only; the who/where stays in the audit log, never a metric label.
        recordAuthMetric("auth_policy_block_total", { reason: "method" });
        throw new ForbiddenError(
          "method_not_allowed",
          "Your organization does not permit this sign-in method. Use an approved method to continue.",
        );
      }
    }
  }

  let workspaceId = txn.workspaceId;
  if (workspaceId) {
    // Untrusted client selection: must be an active workspace membership WITHIN the resolved tenant.
    const role = await workspaceRepository.getRoleForUser(tenantId, workspaceId, txn.userId);
    if (!role) throw new ForbiddenError("workspace_forbidden");
  } else {
    // No explicit selection reached finalize (single-workspace fast path, or a flow that skipped the picker):
    // land on the remembered / default / first workspace deterministically rather than leaving the session
    // workspace-less, which breaks every workspace-scoped surface. (Issue 2c/2b.)
    const ws = await getWorkspaces(txn, tenantId);
    workspaceId =
      ws.length === 1
        ? ws[0]?.id
        : ws.length > 1
          ? ((await workspaceRepository.resolveLandingWorkspace(tenantId, txn.userId)) ?? undefined)
          : undefined;
  }

  // Remember the resolved workspace as this org's default so the user's NEXT login lands here (Issue 2c).
  if (workspaceId) await tenantMemberRepository.setLastWorkspace(tenantId, txn.userId, workspaceId);

  // Two genuinely-independent reads gate the code and must both complete before it is minted: the durable
  // session (its sessionId binds the code) and the platform super-admin flag (ADR-0032 → access-token `pa`
  // claim). Run them concurrently — neither depends on the other.
  const [session, user] = await Promise.all([
    createSession({
      userId: txn.userId,
      tenantId,
      workspaceId,
      appOrigin: txn.appOrigin,
      ipAddress: txn.clientIp,
      userAgent: ctx.userAgent,
      // P1-01 Gate D: undefined unless AUTH_POLICY_ENFORCEMENT_ENABLED === "true" AND the tenant set a timeout.
      maxLifetimeSeconds: sessionMaxLifetimeSeconds,
    }),
    userRepository.findById(txn.userId),
  ]);

  const code = await issueCode({
    userId: txn.userId,
    tenantId,
    sessionId: session.sessionId,
    appOrigin: txn.appOrigin,
    clientIp: txn.clientIp,
    codeChallenge: txn.codeChallenge,
    workspaceId,
    isPlatformAdmin: user?.isPlatformAdmin ?? false,
  });

  // Off the critical path: the last-login stamp and the success-audit row do NOT gate the issued code/redirect
  // — both are non-authoritative side effects. apps/auth is a long-lived `next start` (Node) process, so a
  // detached promise runs after the response on the same process. The login.success audit event is STILL
  // emitted (recordAuthEvent swallows its own failures, ADR-0031 §1) — it is just not awaited before
  // returning; ADR-0031 explicitly classes auth audit as observational, best-effort, and NOT transactionally
  // guaranteed, so not awaiting it does not weaken any durability promise (a process recycle in the brief
  // window between response and settle could drop it — the same best-effort risk a failed insert already
  // carries). login.success — authentication fully succeeded (ADR-0031 §2; covers password/magic/SSO).
  // SLI counter (in-process, synchronous): the login success rate on-call must see BEFORE any enforcement flip.
  // method defaults to "password" when the txn predates the method field (older in-flight Redis row).
  recordAuthMetric("auth_login_total", { result: "success", method: txn.method ?? "password" });
  // SHADOW (off unless AUTH_POLICY_SHADOW_ENABLED="true"): validate the effective-policy engine against the live
  // policy on real login traffic before any cutover. Detached (never awaited) + fully try/caught inside, so it
  // can neither slow nor break the login it runs alongside; it enforces nothing.
  if (env.AUTH_POLICY_SHADOW_ENABLED === "true") {
    void shadowComparePolicy({ tenantId, workspaceId: workspaceId ?? undefined });
  }
  void Promise.allSettled([
    userRepository.touchLastLogin(txn.userId),
    recordAuthEvent({
      tenantId,
      workspaceId: workspaceId ?? null,
      actorUserId: txn.userId,
      action: "login.success",
      entityType: "user",
      entityId: txn.userId,
      metadata: { sessionId: session.sessionId },
      ipAddress: txn.clientIp,
      userAgent: ctx.userAgent ?? null,
      originDomain: new URL(env.AUTH_ORIGIN).host,
    }),
  ]).then((results) => {
    // touchLastLogin has no error handler of its own (recordAuthEvent does). Surface a failed last-login stamp
    // as a warning so a regression is not silent — never log the userId or any identifier/PII.
    if (results[0]?.status === "rejected") {
      const reason = results[0].reason;
      log.warn("login.touchLastLogin.failed", {
        err: reason instanceof Error ? reason.name : "unknown",
      });
    }
  });

  return {
    code,
    refreshToken: session.refreshToken,
    refreshMaxAge: env.REFRESH_TOKEN_TTL_SECONDS,
    appOrigin: txn.appOrigin,
    state: txn.state,
  };
}
