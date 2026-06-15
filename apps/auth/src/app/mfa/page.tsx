// page.tsx — Step 3: the MFA challenge. 6-digit code (auto-submits on the 6th digit), a "trust this device"
// option, and a recovery-code escape hatch. Requires a pending login transaction (else back to /login).
// SSR + WCAG AA; the auto-submit is a bundled-script progressive enhancement (nonce-CSP safe).
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { OtpInput } from "@/shared/OtpInput";
import { getLoginTransaction } from "@leadwolf/auth";
import { Alert, Button, Checkbox, Label } from "@leadwolf/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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
        <a
          className="underline underline-offset-2 hover:text-muted-foreground"
          href="/mfa/recovery"
        >
          Use a recovery code instead
        </a>
      }
    >
      <form action={submitMfa} noValidate>
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
        <Button type="submit" size="full">
          Verify
        </Button>
      </form>
    </AuthShell>
  );
}
