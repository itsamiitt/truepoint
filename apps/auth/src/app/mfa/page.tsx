// page.tsx — Step 3: the MFA challenge. 6-digit code (auto-submits on the 6th digit), a "trust this device"
// option, and a recovery-code escape hatch. Requires a pending login transaction (else back to /login).
// SSR + WCAG AA; the auto-submit is a bundled-script progressive enhancement (nonce-CSP safe).
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getLoginTransaction } from "@leadwolf/auth";
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { OtpInput } from "@/shared/OtpInput";
import { submitMfa } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function MfaPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId || !(await getLoginTransaction(txnId))) redirect("/login");

  return (
    <AuthShell
      title="Two-step verification"
      subtitle="Enter the 6-digit code from your authenticator app."
      footer={
        <a className="auth-link" href="/mfa/recovery">
          Use a recovery code instead
        </a>
      }
    >
      <form action={submitMfa} noValidate>
        <div className="auth-field">
          <label className="auth-label" htmlFor="code">
            Verification code
          </label>
          <OtpInput />
        </div>
        <label className="auth-checkbox">
          <input type="checkbox" name="trust_device" value="1" />
          <span>Trust this device for 30 days</span>
        </label>
        {sp.error ? (
          <p className="auth-error" role="alert">
            That code didn&apos;t match. Try again.
          </p>
        ) : null}
        <button className="auth-button" type="submit">
          Verify
        </button>
      </form>
    </AuthShell>
  );
}
