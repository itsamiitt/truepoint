// flow.ts — the login state machine after primary auth (17 §2). resolveNextStep decides whether MFA or
// workspace selection is still required; finalizeLogin runs ONLY when all factors pass — it opens the
// durable session and issues the single-use cross-domain code. Keeps session/code creation out of the
// transport layer.

import { env } from "@leadwolf/config";
import { userRepository, workspaceRepository } from "@leadwolf/db";
import { issueCode } from "./code.ts";
import type { LoginTransaction } from "./loginTransaction.ts";
import { createSession } from "./session.ts";

export type LoginStep = "mfa" | "workspace" | "complete";

export async function resolveNextStep(txn: LoginTransaction): Promise<LoginStep> {
  // MFA: required when the user has a verified method enrolled (user opt-in). Tenant/workspace policy
  // enforcement (mfa_enforcement = required) layers on top once those policy repos are wired (ADR-0018).
  if (!txn.mfaVerified) {
    const methods = await userRepository.listMfaMethods(txn.userId);
    if (methods.some((m) => m.verifiedAt)) return "mfa";
  }
  // Workspace: prompt only when the user can access more than one (a single one auto-selects at finalize).
  if (!txn.workspaceId) {
    const workspaces = await workspaceRepository.listForUser(txn.tenantId, txn.userId);
    if (workspaces.length > 1) return "workspace";
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
  let workspaceId = txn.workspaceId;
  if (!workspaceId) {
    const ws = await workspaceRepository.listForUser(txn.tenantId, txn.userId);
    if (ws.length === 1) workspaceId = ws[0]?.id;
  }

  const session = await createSession({
    userId: txn.userId,
    appOrigin: txn.appOrigin,
    ipAddress: txn.clientIp,
    userAgent: ctx.userAgent,
  });
  await userRepository.touchLastLogin(txn.userId);

  const code = await issueCode({
    userId: txn.userId,
    tenantId: txn.tenantId,
    sessionId: session.sessionId,
    appOrigin: txn.appOrigin,
    clientIp: txn.clientIp,
    codeChallenge: txn.codeChallenge,
    workspaceId,
  });

  return {
    code,
    refreshToken: session.refreshToken,
    refreshMaxAge: env.REFRESH_TOKEN_TTL_SECONDS,
    appOrigin: txn.appOrigin,
    state: txn.state,
  };
}
