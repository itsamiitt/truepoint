// enroll/page.tsx — the one-time TOTP-enrollment + recovery-code display, driven by the short-lived
// lw_acct_enroll cookie set by the enroll actions. Two states:
//   • kind: "totp"     → show the secret (manual key + otpauth URI) and a "confirm your first code" form.
//   • kind: "recovery" → show the freshly-generated recovery codes ONCE, with a "I've saved them" finish.
// No cookie / wrong state → bounce back to /account/security (the display is strictly one-time: finishEnroll
// deletes the cookie). GATED by requireUser. SSR + WCAG 2.2 AA; no inline scripts (strict nonce-CSP preserved).
//
// CONFIRM (QR image): the QR is rendered as the scannable otpauth:// URI + the manual-entry key only. A visual
// QR <img> needs a server-side data-URI generator (CSP allows `img-src 'self' data:`, so a `data:` QR is the
// CSP-safe path) — there is no QR library in the repo, so the image is a follow-up; the manual key + URI are
// fully functional for every authenticator app in the meantime.
import { requireUser } from "@/lib/requireUser";
import { AccountShell } from "@/shared/AccountShell";
import { OtpInput } from "@/shared/OtpInput";
import styles from "@/shared/auth.module.css";
import { totpKeyUri } from "@leadwolf/auth";
import { Alert, Button } from "@leadwolf/ui";
import { redirect } from "next/navigation";
import { finishEnroll, verifyTotpEnroll } from "../actions";
import { readEnrollResult } from "../enrollCookie";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function EnrollPage({ searchParams }: { searchParams: SearchParams }) {
  const acct = await requireUser();
  const sp = await searchParams;
  const result = await readEnrollResult();
  if (!result) redirect("/account/security#mfa");

  if (result.kind === "totp") {
    const uri = totpKeyUri(result.secret, acct.user.email);
    return (
      <AccountShell title="Set up authenticator app" sections={[]}>
        <section
          aria-labelledby="enroll-totp-heading"
          style={{
            padding: "var(--tp-space-6)",
            background: "var(--tp-surface)",
            border: "1px solid var(--tp-hairline-2)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--tp-shadow-card-hover)",
          }}
        >
          <h2
            id="enroll-totp-heading"
            style={{ marginBottom: "var(--tp-space-2)", fontSize: 17, fontWeight: 600 }}
          >
            1 · Add the key to your app
          </h2>
          <p style={{ marginBottom: "var(--tp-space-3)", fontSize: 13, color: "var(--tp-ink-3)" }}>
            In your authenticator app, add an account using this setup key (or the link below). Keep
            it secret — anyone with this key can generate your codes.
          </p>
          <dl
            style={{
              marginBottom: "var(--tp-space-5)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--tp-space-2)",
              fontSize: 14,
            }}
          >
            <div>
              <dt style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Setup key</dt>
              <dd className={styles.selectable}>{result.secret}</dd>
            </div>
            <div>
              <dt style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Setup link (otpauth)</dt>
              <dd
                style={{
                  userSelect: "all",
                  wordBreak: "break-all",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: "var(--tp-ink-3)",
                }}
              >
                {uri}
              </dd>
            </div>
          </dl>

          <h2 style={{ marginBottom: "var(--tp-space-2)", fontSize: 17, fontWeight: 600 }}>
            2 · Confirm a code
          </h2>
          <p style={{ marginBottom: "var(--tp-space-3)", fontSize: 13, color: "var(--tp-ink-3)" }}>
            Enter the 6-digit code your app shows now.
          </p>
          {sp.error ? (
            <Alert variant="destructive" role="alert" className={styles.spaced}>
              That code didn't match. Check your app's time sync and try again.
            </Alert>
          ) : null}
          <form action={verifyTotpEnroll} noValidate>
            <div style={{ marginBottom: "var(--tp-space-4)", maxWidth: 280 }}>
              <OtpInput />
            </div>
            <div style={{ maxWidth: 220 }}>
              <Button type="submit" size="full">
                Confirm and enable
              </Button>
            </div>
          </form>
        </section>
      </AccountShell>
    );
  }

  // kind: "recovery" — shown ONCE.
  return (
    <AccountShell title="Save your recovery codes" sections={[]}>
      <section
        aria-labelledby="enroll-recovery-heading"
        style={{
          padding: "var(--tp-space-6)",
          background: "var(--tp-surface)",
          border: "1px solid var(--tp-hairline-2)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--tp-shadow-card-hover)",
        }}
      >
        <h2
          id="enroll-recovery-heading"
          style={{ marginBottom: "var(--tp-space-2)", fontSize: 17, fontWeight: 600 }}
        >
          Recovery codes
        </h2>
        {/* biome-ignore lint/a11y/useSemanticElements: Alert renders a styled div; role=status marks the live region */}
        <Alert variant="default" role="status" className={styles.spaced}>
          These codes are shown once. Store them somewhere safe — each one signs you in if you lose
          your authenticator, and works only once.
        </Alert>
        <ul
          style={{
            marginBottom: "var(--tp-space-5)",
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "var(--tp-space-2)",
            fontFamily: "var(--font-mono)",
            fontSize: 14,
          }}
          aria-label="Recovery codes"
        >
          {result.codes.map((c) => (
            <li key={c} className={styles.selectableBox}>
              {c}
            </li>
          ))}
        </ul>
        <form action={finishEnroll}>
          <div style={{ maxWidth: 260 }}>
            <Button type="submit" size="full">
              I've saved my codes
            </Button>
          </div>
        </form>
      </section>
    </AccountShell>
  );
}
