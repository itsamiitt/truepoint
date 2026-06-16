// flow.ts — the login state machine after primary auth (17 §2). resolveNextStep decides MFA → org →
// workspace; finalizeLogin runs ONLY when all factors pass — it resolves the active org + workspace, opens
// the durable session (carrying that scope), and issues the single-use cross-domain code. (ADR-0019/0020.)

import { env } from "@leadwolf/config";
import { tenantMemberRepository, userRepository, workspaceRepository } from "@leadwolf/db";
import { InvalidCredentialsError } from "@leadwolf/types";
import { recordAuthEvent } from "./auditEvent.ts";
import { issueCode } from "./code.ts";
import { type LoginTransaction, patchLoginTransaction } from "./loginTransaction.ts";
import { createSession } from "./session.ts";

export type LoginStep = "mfa" | "org" | "workspace" | "complete";

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
    const orgs = await tenantMemberRepository.listForUser(txn.userId);
    if (orgs.length > 1) return "org";
    tenantId = orgs[0]?.tenantId;
    if (!tenantId) return "complete"; // no membership (edge) — finalizeLogin surfaces it
    await patchLoginTransaction(txnId, { tenantId });
  }

  // Workspace: pick when the chosen org has >1 accessible workspace; a single one auto-selects.
  if (!txn.workspaceId) {
    const ws = await workspaceRepository.listForUser(tenantId, txn.userId);
    if (ws.length > 1) return "workspace";
  }
  return "complete";
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
  // Resolve the active org (explicit or single membership) and workspace (explicit or single).
  let tenantId = txn.tenantId;
  if (!tenantId) {
    const orgs = await tenantMemberRepository.listForUser(txn.userId);
    tenantId = orgs[0]?.tenantId;
  }
  if (!tenantId) throw new InvalidCredentialsError(); // no org membership — cannot complete

  let workspaceId = txn.workspaceId;
  if (!workspaceId) {
    const ws = await workspaceRepository.listForUser(tenantId, txn.userId);
    if (ws.length === 1) workspaceId = ws[0]?.id;
  }

  const session = await createSession({
    userId: txn.userId,
    tenantId,
    workspaceId,
    appOrigin: txn.appOrigin,
    ipAddress: txn.clientIp,
    userAgent: ctx.userAgent,
  });
  await userRepository.touchLastLogin(txn.userId);

  // Carry the platform super-admin flag (ADR-0032) into the cross-domain code → access-token `pa` claim.
  const user = await userRepository.findById(txn.userId);

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

  // login.success — authentication fully succeeded (ADR-0031 §2; covers password/magic/SSO via finalize).
  await recordAuthEvent({
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
  });

  return {
    code,
    refreshToken: session.refreshToken,
    refreshMaxAge: env.REFRESH_TOKEN_TTL_SECONDS,
    appOrigin: txn.appOrigin,
    state: txn.state,
  };
}
