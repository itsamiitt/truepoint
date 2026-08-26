// page.tsx — Step 3: the MFA challenge. 6-digit code (auto-submits on the 6th digit), a "trust this device"
// option (flag-gated on TRUSTED_DEVICES_ENABLED — hidden until its backend exists), and a recovery-code escape
// hatch. TOTP (authenticator) is the default; a user who can't reach their authenticator can request an emailed
// code (?method=email_otp, AUTH-025) — the TOTP path is unchanged, the email option is additive. Requires a
// pending login transaction (else back to /login). SSR + WCAG AA.
import { authPath } from "@/lib/authUrl";
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { OtpInput } from "@/shared/OtpInput";
import styles from "@/shared/auth.module.css";
import { getLoginTransaction } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { webauthnCredentialRepository } from "@leadwolf/db";
import { Alert, Button, Checkbox, Label } from "@leadwolf/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PasskeySignIn } from "./PasskeySignIn";
import { sendEmailOtp, submitMfa } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function MfaPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  const txn = txnId ? await getLoginTransaction(txnId) : null;
  if (!txn) redirect("/login");

  const isEmailOtp = sp.method === "email_otp";
  // Only offer the passkey option when the user has one enrolled — else the prompt would have no credential to
  // match and just fail. Owner-connection read (webauthn_credentials is REVOKEd from leadwolf_app).
  const hasPasskeys =
    env.WEBAUTHN_ENABLED &&
    (await webauthnCredentialRepository.listSummaryForUser(txn.userId)).length > 0;

  // No `footer` (the "Use a recovery code instead" escape hatch) is passed: /mfa/recovery has NO route and
  // there is no recovery-code table — mfa.ts ships the generate/match primitives but mfaVerify.ts:2-3 defers
  // the store to the M11 MFA depth. The link was a 404, so a user locked out of their authenticator was sent
  // to a dead end rather than told the truth. Omitted until the flow exists, matching how login/page.tsx
  // handles the unbuilt social-OAuth button (AUTH-015: hide now, build in the roadmap — never present a
  // broken control). Restore the footer in the same change that adds the route.
  return (
    <AuthShell
      title="Two-step verification"
      subtitle={
        isEmailOtp
          ? "Enter the 6-digit code we emailed you."
          : "Enter the 6-digit code from your authenticator app."
      }
    >
      <form action={submitMfa} noValidate>
        {isEmailOtp ? <input type="hidden" name="method" value="email_otp" /> : null}
        <div className={styles.spaced}>
          <Label htmlFor="code">Verification code</Label>
          <OtpInput />
        </div>
        {/* Trusted-device MFA skip is OFF until its backend is built + reviewed (MFA-bypass surface). Hidden
            rather than shown as a no-op — a checkbox that silently does nothing is a trust bug. */}
        {env.TRUSTED_DEVICES_ENABLED ? (
          <label
            style={{
              marginBottom: "var(--tp-space-4)",
              display: "flex",
              alignItems: "center",
              gap: "var(--tp-space-2)",
              fontSize: "var(--tp-text-label)",
            }}
            htmlFor="trust_device"
          >
            <Checkbox id="trust_device" name="trust_device" value="1" /> Trust this device for 30
            days
          </label>
        ) : null}
        {sp.error ? (
          <Alert variant="destructive" role="alert" className={styles.spaced}>
            That code didn&apos;t match. Try again.
          </Alert>
        ) : null}
        {isEmailOtp && sp.sent === "1" ? (
          <p
            style={{
              marginBottom: "var(--tp-space-4)",
              fontSize: "var(--tp-text-label)",
              color: "var(--tp-ink-3)",
            }}
          >
            We emailed a code to your address. It expires in 15 minutes.
          </p>
        ) : null}
        {isEmailOtp && sp.sent === "rate" ? (
          <Alert variant="destructive" role="alert" className={styles.spaced}>
            Too many code requests. Wait a moment, or use your authenticator.
          </Alert>
        ) : null}
        <Button type="submit" size="full">
          Verify
        </Button>
      </form>

      {isEmailOtp ? (
        <div
          style={{
            marginTop: "var(--tp-space-3)",
            textAlign: "center",
            fontSize: "var(--tp-text-label)",
          }}
        >
          <a className={styles.link} href={authPath("/mfa")}>
            Use your authenticator instead
          </a>
        </div>
      ) : (
        <form action={sendEmailOtp} style={{ marginTop: "var(--tp-space-3)" }}>
          <Button type="submit" variant="ghost" size="full">
            Email me a code instead
          </Button>
        </form>
      )}

      {hasPasskeys && !isEmailOtp ? (
        <div style={{ marginTop: "var(--tp-space-3)" }}>
          <PasskeySignIn />
        </div>
      ) : null}
    </AuthShell>
  );
}
