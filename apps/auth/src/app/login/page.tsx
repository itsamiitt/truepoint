// page.tsx — Step 1: the identifier screen (auth.truepoint.in/login). SSR, works without JS (the form
// posts to a server action), keyboard-first, WCAG AA. Accepts an email OR a username; the action resolves
// whether the identity exists and routes to SSO / password / magic, or to registration (ADR-0020). A
// Turnstile widget + per-IP/per-identifier rate-limit gate the existence reveal. Carries the app's
// PKCE/return context through the flow as hidden fields. "Continue with Google" begins social OAuth.
import { redirectIfAuthenticated } from "@/lib/sessionGuard";
import { AuthShell } from "@/shared/AuthShell";
import { SubmitButton } from "@/shared/SubmitButton";
import { TurnstileWidget } from "@/shared/TurnstileWidget";
import { Alert, Button, Input, Label, Separator } from "@leadwolf/ui";
import { submitIdentifier } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

// The identifier step reveals existence by design, so its errors are specific (unlike the uniform
// credential-step error). "rate"/"bot" are mitigation trips; the default covers a missing identifier.
const ERRORS: Record<string, string> = {
  rate: "Too many attempts. Wait a moment and try again.",
  bot: "We couldn't verify you're human. Please try again.",
  magic: "That sign-in link was invalid or expired. Enter your email to try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  // Already signed in? Bounce to the app instead of showing the sign-in form again (the app shell signs them in).
  await redirectIfAuthenticated(sp.app_origin);
  const appOrigin = sp.app_origin ?? "";
  const codeChallenge = sp.code_challenge ?? "";
  const state = sp.state ?? "";
  // Prefill the identifier when we arrive back from a later step — the password/magic "change" link and the
  // signup/forgot/sso screens all carry ?email — so the person never has to retype it (bug 1). Matches the
  // signup/forgot/magic prefill; the field stays editable so "change" still lets them switch accounts.
  const prefill = sp.email ?? "";
  const oauthHref = `/oauth/google?${new URLSearchParams({ app_origin: appOrigin, code_challenge: codeChallenge, state })}`;
  const errorMessage = sp.error
    ? (ERRORS[sp.error] ?? "Enter your email or username to continue.")
    : null;
  // Success notice after a completed password reset (/reset → /login?reset=1).
  const notice =
    sp.reset === "1" ? "Your password has been updated — sign in with your new password." : null;

  return (
    <AuthShell
      title="Sign in or create an account"
      subtitle="Enter your email or username to continue."
    >
      {notice ? (
        <Alert aria-live="polite" className="mb-4">
          {notice}
        </Alert>
      ) : null}
      <Button asChild variant="outline" size="full">
        <a href={oauthHref}>Continue with Google</a>
      </Button>

      <Separator label="or" />

      <form action={submitIdentifier} noValidate>
        <input type="hidden" name="app_origin" value={appOrigin} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="state" value={state} />
        <div className="mb-4">
          <Label htmlFor="identifier">Email or username</Label>
          <Input
            id="identifier"
            name="identifier"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="you@company.com"
            defaultValue={prefill}
            required
            autoFocus
            aria-invalid={errorMessage ? "true" : undefined}
          />
        </div>
        <TurnstileWidget />
        {errorMessage ? (
          <Alert variant="destructive" role="alert" className="mb-4 tp-shake">
            {errorMessage}
          </Alert>
        ) : null}
        <SubmitButton>Continue</SubmitButton>
      </form>
    </AuthShell>
  );
}
