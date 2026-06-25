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
          className="rounded-[var(--radius)] border border-[var(--tp-hairline-2)] bg-[var(--tp-surface)] px-6 py-6 shadow-[0_8px_30px_rgba(17,24,39,0.06)]"
        >
          <h2 id="enroll-totp-heading" className="mb-2 text-[17px] font-semibold">
            1 · Add the key to your app
          </h2>
          <p className="mb-3 text-[13px] text-[var(--tp-ink-3)]">
            In your authenticator app, add an account using this setup key (or the link below). Keep it
            secret — anyone with this key can generate your codes.
          </p>
          <dl className="mb-5 flex flex-col gap-2 text-sm">
            <div>
              <dt className="text-[12px] text-[var(--tp-ink-3)]">Setup key</dt>
              <dd className="select-all break-all font-mono text-[13px]">{result.secret}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-[var(--tp-ink-3)]">Setup link (otpauth)</dt>
              <dd className="select-all break-all font-mono text-[12px] text-[var(--tp-ink-3)]">
                {uri}
              </dd>
            </div>
          </dl>

          <h2 className="mb-2 text-[17px] font-semibold">2 · Confirm a code</h2>
          <p className="mb-3 text-[13px] text-[var(--tp-ink-3)]">
            Enter the 6-digit code your app shows now.
          </p>
          {sp.error ? (
            <Alert variant="destructive" role="alert" className="mb-4">
              That code didn't match. Check your app's time sync and try again.
            </Alert>
          ) : null}
          <form action={verifyTotpEnroll} noValidate>
            <div className="mb-4 max-w-[280px]">
              <OtpInput />
            </div>
            <div className="max-w-[220px]">
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
        className="rounded-[var(--radius)] border border-[var(--tp-hairline-2)] bg-[var(--tp-surface)] px-6 py-6 shadow-[0_8px_30px_rgba(17,24,39,0.06)]"
      >
        <h2 id="enroll-recovery-heading" className="mb-2 text-[17px] font-semibold">
          Recovery codes
        </h2>
        <Alert variant="default" role="status" className="mb-4">
          These codes are shown once. Store them somewhere safe — each one signs you in if you lose your
          authenticator, and works only once.
        </Alert>
        <ul
          className="mb-5 grid grid-cols-2 gap-2 font-mono text-[14px]"
          aria-label="Recovery codes"
        >
          {result.codes.map((c) => (
            <li
              key={c}
              className="select-all rounded-[var(--radius)] border border-[var(--tp-hairline-2)] px-3 py-2"
            >
              {c}
            </li>
          ))}
        </ul>
        <form action={finishEnroll}>
          <div className="max-w-[260px]">
            <Button type="submit" size="full">
              I've saved my codes
            </Button>
          </div>
        </form>
      </section>
    </AccountShell>
  );
}
