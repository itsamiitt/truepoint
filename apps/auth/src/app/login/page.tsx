// page.tsx — Step 1: the identifier screen (auth.truepoint.in/login). SSR, works without JS (the form
// posts to a server action), keyboard-first, WCAG AA. Accepts an email OR a username; the action resolves
// whether the identity exists and routes to SSO / password / magic, or to registration (ADR-0020). A
// Turnstile widget + per-IP/per-identifier rate-limit gate the existence reveal. Carries the app's
// PKCE/return context through the flow as hidden fields. "Continue with Google" begins social OAuth.
import { AuthShell } from "@/shared/AuthShell";
import { TurnstileWidget } from "@/shared/TurnstileWidget";
import { Alert, Button, Input, Label, Separator } from "@leadwolf/ui";
import { submitIdentifier } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

// The identifier step reveals existence by design, so its errors are specific (unlike the uniform
// credential-step error). "rate"/"bot" are mitigation trips; the default covers a missing identifier.
const ERRORS: Record<string, string> = {
  rate: "Too many attempts. Wait a moment and try again.",
  bot: "We couldn't verify you're human. Please try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const appOrigin = sp.app_origin ?? "";
  const codeChallenge = sp.code_challenge ?? "";
  const state = sp.state ?? "";
  const oauthHref = `/oauth/google?${new URLSearchParams({ app_origin: appOrigin, code_challenge: codeChallenge, state })}`;
  const errorMessage = sp.error
    ? (ERRORS[sp.error] ?? "Enter your email or username to continue.")
    : null;

  return (
    <AuthShell
      title="Sign in or create an account"
      subtitle="Enter your email or username to continue."
    >
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
            required
            autoFocus
            aria-invalid={errorMessage ? "true" : undefined}
          />
        </div>
        <TurnstileWidget />
        {errorMessage ? (
          <Alert variant="destructive" role="alert" className="mb-4">
            {errorMessage}
          </Alert>
        ) : null}
        <Button type="submit" size="full">
          Continue
        </Button>
      </form>
    </AuthShell>
  );
}
