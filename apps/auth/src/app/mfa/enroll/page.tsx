// enroll/page.tsx — the MID-LOGIN forced MFA-enrollment screen (P1-01 sub-gate A). A required-MFA org routes
// an un-enrolled user HERE (resolveNextStep → "mfa_enroll") instead of erroring, but ONLY when the global
// kill-switch AUTH_POLICY_ENFORCEMENT_ENABLED === "true" — with the flag off nothing redirects here. Distinct
// from /account/security/enroll: that runs on a durable session (requireUser); THIS runs on the pending login
// transaction (the user proved their primary factor this flow but is not yet a durable session), so it gates on
// the login-txn cookie, not a signed-in session. Uses AuthShell + OtpInput like the rest of the login flow.
//
// Three states:
//   • no enroll cookie → intro + "Begin setup" (startMfaEnroll generates the secret into the one-time cookie).
//   • kind: "totp"     → show the secret (manual key + otpauth URI) and a "confirm your first code" form.
//   • kind: "recovery" → show the freshly-generated recovery codes ONCE, with a "Continue" finish that
//                        completes the login transaction.
// SSR + WCAG 2.2 AA; no inline scripts (strict nonce-CSP preserved). The QR is the scannable otpauth:// URI +
// the manual-entry key — the same approach as /account/security/enroll (no QR-image library in the repo yet).
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { OtpInput } from "@/shared/OtpInput";
import styles from "@/shared/auth.module.css";
import { getLoginTransaction, totpKeyUri } from "@leadwolf/auth";
import { userRepository } from "@leadwolf/db";
import { Alert, Button } from "@leadwolf/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { finishMfaEnroll, startMfaEnroll, verifyMfaEnroll } from "./actions";
import { readMfaEnrollResult } from "./enrollCookie";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function MfaEnrollPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;

  // Gate on the PENDING LOGIN TRANSACTION (never a durable session): no txn → back to /login. The userId used
  // to label the authenticator URI comes from the transaction, never a request value.
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  const txn = txnId ? await getLoginTransaction(txnId) : null;
  if (!txn) redirect("/login");

  const result = await readMfaEnrollResult();

  // State 1 — no secret generated yet: forced-enrollment intro.
  if (!result) {
    return (
      <AuthShell
        title="Set up two-step verification"
        subtitle="Your organization requires multi-factor authentication. Add an authenticator app to finish signing in."
      >
        {sp.error === "expired" ? (
          <Alert variant="destructive" role="alert" className={styles.spaced}>
            That enrollment timed out. Start again.
          </Alert>
        ) : null}
        <form action={startMfaEnroll}>
          <Button type="submit" size="full">
            Begin setup
          </Button>
        </form>
      </AuthShell>
    );
  }

  // State 2 — show the secret + verify the first code.
  if (result.kind === "totp") {
    const user = await userRepository.findById(txn.userId);
    const uri = totpKeyUri(result.secret, user?.email ?? "TruePoint");
    return (
      <AuthShell
        title="Add your authenticator"
        subtitle="In your authenticator app, add an account using this setup key (or the link below), then enter the 6-digit code it shows."
      >
        <dl
          style={{
            marginBottom: "var(--tp-space-5)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--tp-space-2)",
            fontSize: "var(--tp-text-label)",
          }}
        >
          <div>
            <dt style={{ fontSize: "var(--tp-text-caption)", color: "var(--tp-ink-3)" }}>
              Setup key
            </dt>
            <dd className={styles.selectable}>{result.secret}</dd>
          </div>
          <div>
            <dt style={{ fontSize: "var(--tp-text-caption)", color: "var(--tp-ink-3)" }}>
              Setup link (otpauth)
            </dt>
            <dd
              style={{
                userSelect: "all",
                wordBreak: "break-all",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--tp-text-caption)",
                color: "var(--tp-ink-3)",
              }}
            >
              {uri}
            </dd>
          </div>
        </dl>
        {sp.error ? (
          <Alert variant="destructive" role="alert" className={styles.spaced}>
            That code didn&apos;t match. Check your app&apos;s time sync and try again.
          </Alert>
        ) : null}
        <form action={verifyMfaEnroll} noValidate>
          <div className={styles.spaced}>
            <OtpInput />
          </div>
          <Button type="submit" size="full">
            Confirm and enable
          </Button>
        </form>
      </AuthShell>
    );
  }

  // State 3 — recovery codes, shown ONCE; "Continue" finalizes the login transaction.
  return (
    <AuthShell
      title="Save your recovery codes"
      subtitle="Store these somewhere safe — each one signs you in once if you lose your authenticator."
    >
      {/* biome-ignore lint/a11y/useSemanticElements: Alert renders a styled div; role=status marks the live region */}
      <Alert variant="default" role="status" className={styles.spaced}>
        These codes are shown once. Each one works only a single time.
      </Alert>
      <ul
        style={{
          marginBottom: "var(--tp-space-5)",
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "var(--tp-space-2)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--tp-text-label)",
        }}
        aria-label="Recovery codes"
      >
        {result.codes.map((c) => (
          <li key={c} className={styles.selectableBox}>
            {c}
          </li>
        ))}
      </ul>
      <form action={finishMfaEnroll}>
        <Button type="submit" size="full">
          I&apos;ve saved my codes — continue
        </Button>
      </form>
    </AuthShell>
  );
}
