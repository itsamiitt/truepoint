// page.tsx — Registration step 2: enter the 6-digit code mailed to the address being registered (ADR-0020).
// Requires a pending signup transaction (else back to /signup); the code auto-submits on the 6th digit
// (nonce-CSP-safe bundled script). A resend posts to the same transaction. SSR + WCAG AA.
import { SIGNUP_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { OtpInput } from "@/shared/OtpInput";
import { getSignupTransaction } from "@leadwolf/auth";
import { Alert, Button, Label } from "@leadwolf/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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
          <Button type="submit" variant="link" size="sm">
            Didn&apos;t get it? Resend code
          </Button>
        </form>
      }
    >
      {sp.sent ? (
        <Alert aria-live="polite" className="mb-4">
          A new code is on its way.
        </Alert>
      ) : null}
      <form action={submitVerification} noValidate>
        <div className="mb-4">
          <Label htmlFor="code">Verification code</Label>
          <OtpInput />
        </div>
        {sp.error ? (
          <Alert variant="destructive" role="alert" className="mb-4">
            That code is incorrect or expired. Try again.
          </Alert>
        ) : null}
        <Button type="submit" size="full">
          Verify
        </Button>
      </form>
    </AuthShell>
  );
}
