// passwordReset.ts — thin orchestration over the existing email-token + password primitives for the
// /forgot → /reset flow (17 §9). requestPasswordReset is ENUMERATION-SAFE: it returns the same neutral
// shape whether or not the account exists, so the caller's UX can never distinguish them; the raw reset
// code is returned ONLY when the user exists, and solely to hand to the mailer (never logged, never an
// error). completePasswordReset consumes the single-use, short-lived reset token (TTL is the shared
// email-token window) and replaces the Argon2id digest. Tokens never appear in returned errors.

import { tenantMemberRepository, userRepository } from "@leadwolf/db";
import { recordAuthEvent, recordPlatformAuthEvent } from "./auditEvent.ts";
import { createEmailVerification, verifyEmailCode } from "./emailVerification.ts";
import { hashPassword } from "./password.ts";
import { revokeAllSessionsForUser } from "./session.ts";

export interface RequestPasswordResetInput {
  email: string;
  ipAddress?: string;
}

// Neutral by design: `sent` is always true regardless of existence (no enumeration). `code` is present only
// when an account exists, for the caller to email — the caller MUST NOT branch its UX on its presence.
export interface RequestPasswordResetResult {
  sent: true;
  code?: string;
}

export async function requestPasswordReset(
  input: RequestPasswordResetInput,
): Promise<RequestPasswordResetResult> {
  const email = input.email.trim().toLowerCase();
  const user = await userRepository.findByEmail(email);

  if (!user) return { sent: true }; // enumeration-safe: identical shape to the success path

  // Tenant-less identity event (ADR-0031 §3) → platform_audit_log. Emitted ONLY for a known account — there is
  // no row for an unknown email, which preserves non-enumeration (ADR-0031 §4 / ADR-0020). Best-effort: the
  // sink swallows its own failures, so a missed audit never blocks the reset email.
  await recordPlatformAuthEvent({
    action: "password.reset.request",
    actorUserId: user.id,
    ip: input.ipAddress ?? null,
  });

  const { code } = await createEmailVerification({
    email,
    userId: user.id,
    purpose: "reset",
    ipAddress: input.ipAddress,
  });
  return { sent: true, code };
}

export interface CompletePasswordResetInput {
  email: string;
  code: string;
  newPassword: string;
  ipAddress?: string;
}

// Discriminated result mirroring the auth error `code` vocabulary (errors.ts): a bad/expired/replayed
// reset code maps to `invalid_token`. The submitted code is never echoed back in the failure.
export type CompletePasswordResetResult =
  | { ok: true; userId: string }
  | { ok: false; code: "invalid_token" };

export async function completePasswordReset(
  input: CompletePasswordResetInput,
): Promise<CompletePasswordResetResult> {
  const email = input.email.trim().toLowerCase();
  const consumed = await verifyEmailCode({ email, code: input.code, purpose: "reset" });
  if (!consumed) return { ok: false, code: "invalid_token" }; // single-use token expired/replayed/wrong

  const user = await userRepository.findByEmail(email);
  if (!user) return { ok: false, code: "invalid_token" }; // token matched but identity vanished (edge)

  const passwordHash = await hashPassword(input.newPassword);
  await userRepository.setPassword(user.id, passwordHash);

  // Force-logout everywhere: a password reset must evict every existing session (e.g. an attacker who reset
  // BECAUSE they were locked out, or a compromised session). Revokes the durable sessions AND deny-lists their
  // still-live access tokens so the eviction is immediate, not delayed to the ≤15-min token expiry (W5/W6).
  await revokeAllSessionsForUser(user.id);

  // Audit the completion (ADR-0031 §2): when the identity resolves to exactly ONE active tenant, write the
  // tenant-scoped audit_log; with 0 or >1 tenants there is no single tenant to satisfy audit_log's NOT NULL
  // tenant_id, so route to the tenant-less platform_audit_log. Best-effort — both sinks swallow, so a failed
  // audit can never undo a completed reset.
  const tenants = await tenantMemberRepository.listForUser(user.id);
  if (tenants.length === 1 && tenants[0]) {
    await recordAuthEvent({
      tenantId: tenants[0].tenantId,
      actorUserId: user.id,
      action: "password.reset.complete",
      entityType: "user",
      entityId: user.id,
      ipAddress: input.ipAddress ?? null,
    });
  } else {
    await recordPlatformAuthEvent({
      action: "password.reset.complete",
      actorUserId: user.id,
      ip: input.ipAddress ?? null,
    });
  }

  return { ok: true, userId: user.id };
}
