// page.tsx — Registration step 3: set the profile (full name, optional username alias, password) after the
// email is proven (ADR-0020). Requires an email-verified signup transaction (else back to /signup or /verify).
// Submitting provisions the global identity + its org placement and completes the login. SSR + WCAG AA.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSignupTransaction } from "@leadwolf/auth";
import { SIGNUP_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { completeSignup } from "../actions";

type SearchParams = Promise<Record<string, string | undefined>>;

const ERRORS: Record<string, string> = {
  username: "That username is taken. Try another.",
  invalid: "Check the form and try again. Passwords need at least 8 characters.",
};

export default async function ProfilePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const txnId = (await cookies()).get(SIGNUP_TXN_COOKIE)?.value;
  const txn = txnId ? await getSignupTransaction(txnId) : null;
  if (!txn) redirect("/signup");
  if (!txn.emailVerified) redirect("/verify");
  const errorMessage = sp.error ? (ERRORS[sp.error] ?? "Something went wrong. Try again.") : null;

  return (
    <AuthShell title="Finish setting up" subtitle="A few details and you're in.">
      <div className="auth-chip">
        <span>{txn.email}</span>
      </div>

      <form action={completeSignup} noValidate>
        <div className="auth-field">
          <label className="auth-label" htmlFor="full_name">
            Full name
          </label>
          <input
            className="auth-input"
            id="full_name"
            name="full_name"
            type="text"
            autoComplete="name"
            required
            // biome-ignore lint/a11y/noAutofocus: first field of the step focuses by design
            autoFocus
          />
        </div>
        <div className="auth-field">
          <label className="auth-label" htmlFor="username">
            Username <span className="auth-label-hint">(optional)</span>
          </label>
          <input
            className="auth-input"
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            pattern="[a-zA-Z0-9_.\-]{3,32}"
            aria-invalid={sp.error === "username" ? "true" : undefined}
          />
        </div>
        <div className="auth-field">
          <label className="auth-label" htmlFor="password">
            Password
          </label>
          <input
            className="auth-input"
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            aria-invalid={sp.error === "invalid" ? "true" : undefined}
          />
        </div>
        {errorMessage ? (
          <p className="auth-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button className="auth-button" type="submit">
          Create account
        </button>
      </form>
    </AuthShell>
  );
}
