// page.tsx — Registration step 1: confirm the email to register (ADR-0020). Reached when the identifier step
// finds no existing identity; the email arrives prefilled but stays editable. Submitting mails a 6-digit code
// and advances to /verify. SSR, no-JS friendly, carries the app's PKCE/return context as hidden fields.
import { AuthShell } from "@/shared/AuthShell";
import { startSignup } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

const ERRORS: Record<string, string> = {
  email: "Enter a valid email address.",
};

export default async function SignupPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const email = sp.email ?? "";
  const appOrigin = sp.app_origin ?? "";
  const codeChallenge = sp.code_challenge ?? "";
  const state = sp.state ?? "";
  const carry = new URLSearchParams({ email, app_origin: appOrigin, code_challenge: codeChallenge, state });
  const errorMessage = sp.error ? (ERRORS[sp.error] ?? "Something went wrong. Try again.") : null;

  return (
    <AuthShell
      title="Create your account"
      subtitle="We'll email you a code to confirm it's you."
      footer={
        <a className="auth-link" href={`/login?${carry}`}>
          Already have an account? Sign in
        </a>
      }
    >
      <form action={startSignup} noValidate>
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
            defaultValue={email}
            required
            // biome-ignore lint/a11y/noAutofocus: single-field step focuses its input by design
            autoFocus
            aria-invalid={errorMessage ? "true" : undefined}
          />
        </div>
        {errorMessage ? (
          <p className="auth-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button className="auth-button" type="submit">
          Continue
        </button>
      </form>
    </AuthShell>
  );
}
