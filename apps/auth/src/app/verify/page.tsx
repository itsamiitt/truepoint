// page.tsx — Registration step 2: enter the 6-digit code mailed to the address being registered (ADR-0020).
// Requires a pending signup transaction (else back to /signup); the code auto-submits on the 6th digit
// (nonce-CSP-safe bundled script). A resend posts to the same transaction. SSR + WCAG AA.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSignupTransaction } from "@leadwolf/auth";
import { SIGNUP_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { OtpInput } from "@/shared/OtpInput";
import { resendCode, submitVerification } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function VerifyPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const txnId = (await cookies()).get(SIGNUP_TXN_COOKIE)?.value;
  const txn = txnId ? await getSignupTransaction(txnId) : null;
  if (!txn) redirect("/signup");

  return (
    <AuthShell
      title="Check your email"
      subtitle={`We sent a 6-digit code to ${txn.email}.`}
      footer={
        <form action={resendCode}>
          <button className="auth-link" type="submit">
            Didn&apos;t get it? Resend code
          </button>
        </form>
      }
    >
      {sp.sent ? (
        <p className="auth-note" role="status">
          A new code is on its way.
        </p>
      ) : null}
      <form action={submitVerification} noValidate>
        <div className="auth-field">
          <label className="auth-label" htmlFor="code">
            Verification code
          </label>
          <OtpInput />
        </div>
        {sp.error ? (
          <p className="auth-error" role="alert">
            That code is incorrect or expired. Try again.
          </p>
        ) : null}
        <button className="auth-button" type="submit">
          Verify
        </button>
      </form>
    </AuthShell>
  );
}
