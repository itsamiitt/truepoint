// actions.ts — the server actions for the /account/security self-service surface (P1-02). EVERY action:
//   1. resolves the authenticated user via requireUser (the userId is the session's, NEVER a request value —
//      09 access / mass-assignment AC: a user can only ever manage their OWN account);
//   2. re-proves identity (verifyStepUp — current password) before any state change (09 MFA-integrity AC:
//      step-up before password change / MFA enroll / disable / regenerate), which is itself rate-limited;
//   3. emits the relevant audit event where a sink + a declared action exist (see the per-action notes);
//   4. redirects back to the section anchor with a neutral status — no secret/token/code in the URL or logs.
//
// CSP: these are server actions ("use server"); the page ships no inline scripts, so the strict nonce-CSP at
// middleware.ts is preserved unchanged (09 "Strict CSP preserved on new auth-origin client code").
"use server";

import { authUrl } from "@/lib/authUrl";
import { clientIpFromHeaders } from "@/lib/clientIp";
import { passwordChangedEmail } from "@/lib/emails";
import { sendAuthEmail } from "@/lib/mailer";
import { requireUser } from "@/lib/requireUser";
import {
  checkPasswordAcceptable,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
  markManyRevoked,
  markRevoked,
  recordAuthEvent,
  recordPlatformAuthEvent,
  verifyTotp,
} from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { sessionRepository, tenantMemberRepository, userRepository } from "@leadwolf/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
// One-time enrollment artefacts (recovery codes / the TOTP secret) are shown EXACTLY ONCE, on the result
// render, then the cookie is cleared (finishEnroll) — so a refresh/back can't re-leak them and they never
// appear in a query string (which would land in logs/history). 09 secrets AC: shown once, stored hashed.
import { ENROLL_RESULT_COOKIE, ENROLL_RESULT_MAX_AGE, readEnrollResult } from "./enrollCookie";
import { verifyStepUp } from "./stepUp";

// ── Password change ──────────────────────────────────────────────────────────────────────────────────────
// Reuse the P0-02 acceptability gate + Argon2id hash + setPassword, then force-logout EVERYWHERE-ELSE (every
// other session) — the same eviction a reset does, minus THIS device (the user just proved themselves here, so
// keeping them signed in is correct UX and they remain protected because every OTHER session is gone). Audit:
// the declared `password.reset.complete` action (the change analogue), dual-sinked exactly like
// completePasswordReset — tenant audit_log on a single resolved tenant, else the tenant-less platform_audit_log.
export async function changePassword(formData: FormData): Promise<void> {
  const acct = await requireUser();
  const current = String(formData.get("current_password") ?? "");
  const next = String(formData.get("new_password") ?? "");
  const confirm = String(formData.get("confirm_password") ?? "");
  const ip = clientIpFromHeaders(await headers());

  const back = (status: string): never => redirect(`/account/security?password=${status}#password`);

  // Step-up FIRST (rate-limited): a wrong/locked current password fails uniformly before any policy work.
  if (!(await verifyStepUp(acct.user, current))) back("reauth");
  if (next !== confirm) back("mismatch");

  const rejection = await checkPasswordAcceptable(next);
  if (rejection) {
    // Map the policy reason to a neutral status; the page renders the matching localizable message.
    redirect(`/account/security?password=${rejection}#password`);
  }

  const digest = await hashPassword(next);
  await userRepository.setPassword(acct.userId, digest);

  // Evict every OTHER session but KEEP this one. A password CHANGE by an actively-authenticated, stepped-up
  // user is not a reset: they just re-proved the live credential here, so signing THIS device out and forcing
  // a re-login is needless friction. revokeOtherSessionsForUser revokes all of the user's sessions EXCEPT the
  // current one and returns their ids; markManyRevoked then deny-lists those still-live access tokens so the
  // eviction is immediate (not delayed to the ≤15-min token expiry) — identical security to the reset path for
  // every other device, minus the one the user is sitting at. This mirrors revokeAllOtherSessions below.
  // CONFIRM: revokeOtherSessionsForUser lives on `sessionRepository` (the task brief said `userRepository`); the
  // userRepository has no session methods — sessions are part of the session aggregate (see userRepository.ts).
  const otherIds = await sessionRepository.revokeOtherSessionsForUser(acct.userId, acct.sessionId);
  if (otherIds.length > 0) await markManyRevoked(otherIds);

  // Audit (declared action, dual-sink like completePasswordReset). Best-effort; never blocks the change.
  const tenants = await tenantMemberRepository.listForUser(acct.userId);
  if (tenants.length === 1 && tenants[0]) {
    await recordAuthEvent({
      tenantId: tenants[0].tenantId,
      actorUserId: acct.userId,
      action: "password.reset.complete",
      entityType: "user",
      entityId: acct.userId,
      metadata: { via: "account_security" },
      ipAddress: ip,
    });
  } else {
    await recordPlatformAuthEvent({
      action: "password.reset.complete",
      actorUserId: acct.userId,
      ip,
      metadata: { via: "account_security" },
    });
  }

  // Security notification (AUTH-067): tell the owner their password was changed, so an unauthorized change is
  // noticed. To the SESSION's own email (acct.user.email — never a request value). Best-effort + DETACHED so it
  // never fails or delays the change; the failure log carries no PII (the mailer logs its own transport state).
  const secureUrl = authUrl(env.AUTH_ORIGIN, "/forgot");
  void sendAuthEmail({ to: acct.user.email, ...passwordChangedEmail({ secureUrl }) }).catch((e) =>
    console.error(
      "[auth-mail] password-changed notification failed:",
      e instanceof Error ? e.message : e,
    ),
  );

  back("changed");
}

// ── TOTP enrollment: start (generate the secret; show it once on the enroll screen) ─────────────────────
// Step-up is required to begin enrollment so a drive-by cannot silently add a factor. The freshly-generated
// secret is NOT persisted yet — it rides ONLY in the short-lived, HttpOnly, SameSite=Strict result cookie until
// the user proves the first code (verifyTotpEnroll), which is when it is encrypted (secrets.ts) and inserted,
// bound to THIS userId from the session — never a request value (09 MFA-integrity AC). Not persisting until
// verify means an abandoned setup leaves no orphan row.
export async function startTotpEnroll(formData: FormData): Promise<void> {
  const acct = await requireUser();
  const current = String(formData.get("current_password") ?? "");

  if (!(await verifyStepUp(acct.user, current))) {
    redirect("/account/security?mfa=reauth#mfa");
  }

  const secret = generateTotpSecret();
  // Carry the plaintext secret (shown once for the QR / manual key) to the enroll page via the HttpOnly cookie
  // — never a URL/log. The real row is created only at verify, so an abandoned setup leaves nothing behind.
  (await cookies()).set(ENROLL_RESULT_COOKIE, JSON.stringify({ kind: "totp", secret }), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: ENROLL_RESULT_MAX_AGE,
  });
  redirect("/account/security/enroll");
}

// ── TOTP enrollment: verify the first code → persist the VERIFIED method + issue recovery codes ──────────
// Confirms the authenticator is in sync before the factor counts. On success: insert the method already-verified
// (secret encrypted at insert, bound to acct.userId from the session), generate one-time recovery codes (shown
// once), and store ONLY their hashes. A wrong code persists nothing and returns to the enroll screen.
export async function verifyTotpEnroll(formData: FormData): Promise<void> {
  const acct = await requireUser();
  const code = String(formData.get("code") ?? "").trim();

  const pending = await readEnrollResult();
  if (!pending || pending.kind !== "totp") redirect("/account/security?mfa=expired#mfa");

  // Re-prove the authenticator against the secret carried in the (HttpOnly, server-set) cookie. A miss persists
  // nothing — the secret is only ever written after a correct code.
  if (!verifyTotp(pending.secret, code)) {
    redirect("/account/security/enroll?error=1");
  }

  await userRepository.createMfaMethod({
    userId: acct.userId, // bind to THIS user from the session (09 MFA-integrity AC)
    type: "totp",
    secretEnc: encryptSecret(pending.secret),
    label: "Authenticator app",
    verified: true,
  });

  // Issue one-time recovery codes alongside the first verified factor; store hashes only.
  const codes = generateRecoveryCodes();
  await userRepository.replaceRecoveryCodes(
    acct.userId,
    codes.map((c) => hashRecoveryCode(c)),
  );

  // Replace the pending cookie with the one-time recovery codes for the "show once" result render.
  (await cookies()).set(ENROLL_RESULT_COOKIE, JSON.stringify({ kind: "recovery", codes }), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: ENROLL_RESULT_MAX_AGE,
  });

  // Audit the enrollment (09 MFA-integrity AC) — `mfa.enroll` is now a declared tenant `auditAction`. This
  // surface runs on a durable session, so the active tenant is acct.tenantId; emit to audit_log when it
  // resolves (NOT NULL tenant_id), else skip (a tenant-less session → PENDING, same convention as
  // auditSessionRevoke below). Best-effort; recordAuthEvent swallows its own failures and never blocks enroll.
  if (acct.tenantId) {
    await recordAuthEvent({
      tenantId: acct.tenantId,
      workspaceId: acct.workspaceId,
      actorUserId: acct.userId,
      action: "mfa.enroll",
      entityType: "user",
      entityId: acct.userId,
      metadata: { method: "totp", context: "account_security" },
      ipAddress: clientIpFromHeaders(await headers()),
    });
  }

  redirect("/account/security/enroll?done=1");
}

// ── Disable an MFA method (step-up required) ─────────────────────────────────────────────────────────────
// Scoped to (methodId, userId): a foreign id is a no-op (deleteMfaMethod returns 0 → neutral redirect). Step-up
// re-proves the current password first (09 MFA-integrity: disable requires step-up).
export async function disableMfaMethod(formData: FormData): Promise<void> {
  const acct = await requireUser();
  const methodId = String(formData.get("method_id") ?? "");
  const current = String(formData.get("current_password") ?? "");

  if (!(await verifyStepUp(acct.user, current))) {
    redirect("/account/security?mfa=reauth#mfa");
  }
  if (!methodId) redirect("/account/security?mfa=notfound#mfa");

  const removed = await userRepository.deleteMfaMethod(acct.userId, methodId);

  // If that was the user's LAST verified factor, the now-orphaned recovery codes are useless (recovery is a
  // fallback FOR a factor) and would otherwise linger — clear them so disabling all MFA truly removes it.
  // listMfaMethodsDetailed excludes recovery_code rows, so "no verified rows" means "no real factor left".
  if (removed > 0) {
    const remaining = await userRepository.listMfaMethodsDetailed(acct.userId);
    if (!remaining.some((m) => m.verifiedAt)) {
      await userRepository.replaceRecoveryCodes(acct.userId, []);
    }
  }
  // CONFIRM (audit PENDING): same as enroll — no declared `mfa.disable`/`mfa.method.removed` action exists in
  // the closed audit enums, so the removal audit stays PENDING (do not emit an undeclared action).
  redirect(`/account/security?mfa=${removed > 0 ? "disabled" : "notfound"}#mfa`);
}

// ── Regenerate recovery codes (step-up required) ─────────────────────────────────────────────────────────
// Replaces ALL existing recovery codes with a fresh hashed set and shows the new codes ONCE (any previously
// shown codes are invalidated). Step-up required (09 abuse AC: regeneration is a sensitive, rate-limited op).
export async function regenerateRecoveryCodes(formData: FormData): Promise<void> {
  const acct = await requireUser();
  const current = String(formData.get("current_password") ?? "");

  if (!(await verifyStepUp(acct.user, current))) {
    redirect("/account/security?mfa=reauth#mfa");
  }

  const codes = generateRecoveryCodes();
  await userRepository.replaceRecoveryCodes(
    acct.userId,
    codes.map((c) => hashRecoveryCode(c)),
  );

  (await cookies()).set(ENROLL_RESULT_COOKIE, JSON.stringify({ kind: "recovery", codes }), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: ENROLL_RESULT_MAX_AGE,
  });
  redirect("/account/security/enroll?done=1");
}

// ── Revoke ONE of my own sessions ────────────────────────────────────────────────────────────────────────
// Scoped to (sessionId, userId): revokeOwnSession only revokes a session that is genuinely the caller's
// (ownership checked in SQL — a foreign id matches nothing → null → neutral redirect). The current session is
// never offered for revoke in the UI; revoking it here would just sign the user out (still safe). Deny-list the
// revoked session's access token so the eviction is immediate, not delayed to the ≤15-min token expiry.
export async function revokeOwnSession(formData: FormData): Promise<void> {
  const acct = await requireUser();
  const sessionId = String(formData.get("session_id") ?? "");
  if (!sessionId) redirect("/account/security?sessions=notfound#sessions");

  const revoked = await sessionRepository.revokeOwnSession(acct.userId, sessionId);
  if (revoked) {
    await markRevoked(revoked);
    await auditSessionRevoke(acct, { mode: "single", count: 1 });
  }
  redirect(`/account/security?sessions=${revoked ? "revoked" : "notfound"}#sessions`);
}

// ── Revoke ALL OTHER sessions (sign out everywhere else) ─────────────────────────────────────────────────
export async function revokeAllOtherSessions(): Promise<void> {
  const acct = await requireUser();
  const ids = await sessionRepository.revokeOtherSessionsForUser(acct.userId, acct.sessionId);
  if (ids.length > 0) {
    await markManyRevoked(ids);
    await auditSessionRevoke(acct, { mode: "others", count: ids.length });
  }
  redirect("/account/security?sessions=others#sessions");
}

// ── Finish enrollment: clear the one-time result cookie and return to the surface ───────────────────────
// Called by the "I've saved my codes" / "Done" button on the enroll result page. Clearing the HttpOnly cookie
// is what makes the secret/recovery-code display strictly ONE-TIME — a later visit to /enroll finds nothing.
export async function finishEnroll(): Promise<void> {
  await requireUser(); // still gate it to the authenticated user
  (await cookies()).delete(ENROLL_RESULT_COOKIE);
  redirect("/account/security?mfa=enrolled#mfa");
}

// Emit the declared `session.revoked` audit when the current session resolves to a tenant (the audit_log
// tenant_id is NOT NULL). CONFIRM (audit PENDING for the tenant-less case): `session.revoked` exists ONLY in
// the tenant `auditAction` enum — there is no tenant-less platform variant — so a self-service revoke by a user
// whose current session carries no tenant cannot be cleanly audited yet; it stays PENDING (per the task brief),
// rather than emit an undeclared/cross-scope row. Best-effort: recordAuthEvent swallows its own failures.
async function auditSessionRevoke(
  acct: Awaited<ReturnType<typeof requireUser>>,
  meta: { mode: "single" | "others"; count: number },
): Promise<void> {
  if (!acct.tenantId) return; // tenant-less → PENDING (see note above)
  const ip = clientIpFromHeaders(await headers());
  await recordAuthEvent({
    tenantId: acct.tenantId,
    workspaceId: acct.workspaceId,
    actorUserId: acct.userId,
    action: "session.revoked",
    entityType: "user_session",
    entityId: acct.userId,
    metadata: { ...meta, self: true, via: "account_security" },
    ipAddress: ip,
  });
}
