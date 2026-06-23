// page.tsx — Registration step 1: confirm the email to register (ADR-0020). Reached when the identifier step
// finds no existing identity; the email arrives prefilled but stays editable. Submitting mails a 6-digit code
// and advances to /verify. SSR, no-JS friendly, carries the app's PKCE/return context as hidden fields.
import { redirectIfAuthenticated } from "@/lib/sessionGuard";
import { AuthShell } from "@/shared/AuthShell";
import { Alert, Button, Input, Label } from "@leadwolf/ui";
import { startSignup } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

const ERRORS: Record<string, string> = {
  email: "Enter a valid email address.",
};

export default async function SignupPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  await redirectIfAuthenticated(sp.app_origin);
  const email = sp.email ?? "";
  const appOrigin = sp.app_origin ?? "";
  const codeChallenge = sp.code_challenge ?? "";
  const state = sp.state ?? "";
  const carry = new URLSearchParams({
    email,
    app_origin: appOrigin,
    code_challenge: codeChallenge,
    state,
  });
  const errorMessage = sp.error ? (ERRORS[sp.error] ?? "Something went wrong. Try again.") : null;

  return (
    <AuthShell
      title="Create your account"
      subtitle="We'll email you a code to confirm it's you."
      footer={
        <a
          className="underline underline-offset-2 hover:text-muted-foreground"
          href={`/login?${carry}`}
        >
          Already have an account? Sign in
        </a>
      }
    >
      <form action={startSignup} noValidate>
        <input type="hidden" name="app_origin" value={appOrigin} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="state" value={state} />
        <div className="mb-4">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@company.com"
            defaultValue={email}
            required
            autoFocus
            aria-invalid={errorMessage ? "true" : undefined}
          />
        </div>
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
