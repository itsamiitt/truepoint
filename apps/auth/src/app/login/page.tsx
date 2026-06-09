// page.tsx — Step 1: the identifier screen (auth.truepoint.in/login). SSR, works without JS (the form
// posts to a server action), keyboard-first, WCAG AA. Carries the app's PKCE/return context through the
// flow as hidden fields. "Continue with Google" begins social OAuth (initiation route is the next increment).
import { AuthShell } from "@/shared/AuthShell";
import { startPasswordStep } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const appOrigin = sp.app_origin ?? "";
  const codeChallenge = sp.code_challenge ?? "";
  const state = sp.state ?? "";
  const oauthHref = `/oauth/google?${new URLSearchParams({ app_origin: appOrigin, code_challenge: codeChallenge, state })}`;

  return (
    <AuthShell title="Sign in" subtitle="Enter your email to continue.">
      <a className="auth-button auth-button--ghost" href={oauthHref}>
        Continue with Google
      </a>

      <div className="auth-divider">or</div>

      <form action={startPasswordStep} noValidate>
        <input type="hidden" name="app_origin" value={appOrigin} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="state" value={state} />
        <div className="auth-field">
          <label className="auth-label" htmlFor="email">
            Email
          </label>
          <input
            className="auth-input"
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@company.com"
            required
            // biome-ignore lint/a11y/noAutofocus: identifier-first screen focuses the single input by design
            autoFocus
            aria-invalid={sp.error ? "true" : undefined}
          />
        </div>
        {sp.error ? (
          <p className="auth-error" role="alert">
            Check your credentials and try again.
          </p>
        ) : null}
        <button className="auth-button" type="submit">
          Continue
        </button>
      </form>
    </AuthShell>
  );
}
