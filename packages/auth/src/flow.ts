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
import { issueCode } from "./code.ts";
import { isIpAllowed } from "./ipAllowlist.ts";
import { log } from "./log.ts";
import { type LoginTransaction, patchLoginTransaction } from "./loginTransaction.ts";
import { authorizeTenantSelection } from "./scopeGuard.ts";
import { createSession } from "./session.ts";

export type LoginStep = "mfa" | "org" | "workspace" | "complete";

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
  // enforcement layers on top once the policy repos are wired (ADR-0018).
  if (!txn.mfaVerified) {
    const methods = await userRepository.listMfaMethods(txn.userId);
    if (methods.some((m) => m.verifiedAt)) return "mfa";
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
  // / "off") policy are unaffected. WIRE (P1-01 sub-gate A, DEFERRED): route blocked users to a forced
  // in-login MFA-enrollment step in apps/auth instead of erroring (better UX once the enrollment screen
  // exists). This existing gate is UNCHANGED and is NOT behind AUTH_POLICY_ENFORCEMENT_ENABLED — it is the
  // pre-existing behavior the new gates must not regress.
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
  // LOCKOUT-CAPABLE gates: enforced ONLY when the global kill-switch is the literal string "true". Unset/any
  // other value = OFF = today's exact behavior (the merge-safety guarantee — every new gate below is wrapped
  // in this single check, so with the flag off NONE of them can fire). Security ACs → ../../Authentication
  // plan/09-threat-model.md: the gate runs SERVER-SIDE here at finalizeLogin (the authoritative token gate),
  // over the RESOLVED tenant policy (never client input), after the tenant membership is authorized above.
  //
  // Gate D — session timeout: the resolved cap (if any) is captured here and applied at createSession below
  // (the new session's absolute lifetime is min(default, cap)); the refresh path enforces the same absolute
  // cap to force re-auth. Stays undefined when the flag is off → unchanged default session lifetime.
  let sessionMaxLifetimeSeconds: number | undefined;
  if (env.AUTH_POLICY_ENFORCEMENT_ENABLED === "true") {
    const policy = await authPolicyRepository.getForTenant(tenantId);
    if (policy.sessionTimeoutSeconds != null && policy.sessionTimeoutSeconds > 0) {
      sessionMaxLifetimeSeconds = policy.sessionTimeoutSeconds;
    }

    // Gate C — IP allowlist. When the resolved tenant policy pins an allowlist, the client IP captured at the
    // start of THIS login transaction (txn.clientIp, server-observed, not client-supplied) must fall inside
    // at least one CIDR. Match by CIDR NETWORK, never string equality; a malformed entry fails closed for
    // that entry only (isIpAllowed skips it) — it never opens the gate. Empty allowlist = no restriction.
    const allowlist = policy.ipAllowlist ?? [];
    if (allowlist.length > 0 && !isIpAllowed(txn.clientIp, allowlist)) {
      throw new ForbiddenError(
        "ip_not_allowed",
        "Your organization restricts sign-in to approved networks. You are connecting from an address that is not on the allowlist.",
      );
    }

    // Gate B — allowed methods: DEFERRED. isMethodAllowed(policy, method) exists, but the login method is not
    // yet carried on the LoginTransaction, and threading it would touch all four edge callers of
    // createLoginTransaction across apps/auth (password / magic / sso / signup). Out of scope for this
    // increment — see the deferral note in the task report. Do NOT half-wire it here.
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
