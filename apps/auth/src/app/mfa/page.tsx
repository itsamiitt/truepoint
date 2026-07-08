// page.tsx — Step 3: the MFA challenge. 6-digit code (auto-submits on the 6th digit), a "trust this device"
// option, and a recovery-code escape hatch. TOTP (authenticator) is the default; a user who can't reach their
// authenticator can request an emailed code (?method=email_otp, AUTH-025) — the TOTP path is unchanged, the
// email option is additive. Requires a pending login transaction (else back to /login). SSR + WCAG AA.
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { OtpInput } from "@/shared/OtpInput";
import { getLoginTransaction } from "@leadwolf/auth";
import { Alert, Button, Checkbox, Label } from "@leadwolf/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sendEmailOtp, submitMfa } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function MfaPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId || !(await getLoginTransaction(txnId))) redirect("/login");

  const isEmailOtp = sp.method === "email_otp";

  return (
    <AuthShell
      title="Two-step verification"
      subtitle={
        isEmailOtp
          ? "Enter the 6-digit code we emailed you."
          : "Enter the 6-digit code from your authenticator app."
      }
      footer={
        <a
          className="underline underline-offset-2 hover:text-muted-foreground"
          href="/mfa/recovery"
        >
          Use a recovery code instead
        </a>
      }
    >
      <form action={submitMfa} noValidate>
        {isEmailOtp ? <input type="hidden" name="method" value="email_otp" /> : null}
        <div className="mb-4">
          <Label htmlFor="code">Verification code</Label>
          <OtpInput />
        </div>
        <label className="mb-4 flex items-center gap-2 text-sm" htmlFor="trust_device">
          <Checkbox id="trust_device" name="trust_device" value="1" /> Trust this device for 30 days
        </label>
        {sp.error ? (
          <Alert variant="destructive" role="alert" className="mb-4">
            That code didn&apos;t match. Try again.
          </Alert>
        ) : null}
        {isEmailOtp && sp.sent === "1" ? (
          <p className="mb-4 text-sm text-muted-foreground">
            We emailed a code to your address. It expires in 15 minutes.
          </p>
        ) : null}
        {isEmailOtp && sp.sent === "rate" ? (
          <Alert variant="destructive" role="alert" className="mb-4">
            Too many code requests. Wait a moment, or use your authenticator.
          </Alert>
        ) : null}
        <Button type="submit" size="full">
          Verify
        </Button>
      </form>

      {isEmailOtp ? (
        <div className="mt-3 text-center text-sm">
          <a className="underline underline-offset-2 hover:text-muted-foreground" href="/mfa">
            Use your authenticator instead
          </a>
        </div>
      ) : (
        <form action={sendEmailOtp} className="mt-3">
          <Button type="submit" variant="ghost" size="full">
            Email me a code instead
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
