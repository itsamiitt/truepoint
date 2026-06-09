// page.tsx — Step 2A: the password screen. Email shows as a locked chip with a "change" back-link; the
// PKCE/return context rides as hidden fields. SSR, no-JS friendly, keyboard-first, WCAG AA. Show/hide and
// passkey prompt are progressive enhancements layered on top of this base render.
import { AuthShell } from "@/shared/AuthShell";
import { submitPassword } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function PasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const email = sp.email ?? "";
  const carry = new URLSearchParams({
    email,
    app_origin: sp.app_origin ?? "",
    code_challenge: sp.code_challenge ?? "",
    state: sp.state ?? "",
  });

  return (
    <AuthShell
      title="Enter your password"
      footer={
        <a className="auth-link" href={`/forgot?${carry}`}>
          Forgot password?
        </a>
      }
    >
      <div className="auth-chip">
        <span>{email || "your account"}</span>
        <a className="auth-link" href={`/login?${carry}`}>
          change
        </a>
      </div>

      <form action={submitPassword} noValidate>
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="app_origin" value={sp.app_origin ?? ""} />
        <input type="hidden" name="code_challenge" value={sp.code_challenge ?? ""} />
        <input type="hidden" name="state" value={sp.state ?? ""} />
        <div className="auth-field">
          <label className="auth-label" htmlFor="password">
            Password
          </label>
          <input
            className="auth-input"
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            // biome-ignore lint/a11y/noAutofocus: single-field step focuses the password input by design
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
          Sign in
        </button>
      </form>
    </AuthShell>
  );
}
