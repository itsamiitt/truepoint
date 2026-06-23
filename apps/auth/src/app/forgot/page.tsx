// page.tsx — the "forgot password" request screen (17 §9). SSR, no-JS friendly: an email Input (prefilled
// from ?email) posts to the requestReset action, carrying the app's PKCE/return context as hidden fields.
// Enumeration-safe by design — after sending it renders one neutral confirmation regardless of existence.
import { redirectIfAuthenticated } from "@/lib/sessionGuard";
import { AuthShell } from "@/shared/AuthShell";
import { Alert, Button, Input, Label } from "@leadwolf/ui";
import { requestReset } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

// "rate" is the only specific message (a mitigation trip); existence is never revealed, so the default
// covers a missing/invalid email without distinguishing whether the account is real.
const ERRORS: Record<string, string> = {
  rate: "Too many attempts. Wait a moment and try again.",
};

export default async function ForgotPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  await redirectIfAuthenticated(sp.app_origin);
  const email = sp.email ?? "";
  const sent = sp.sent === "1";
  const carry = new URLSearchParams({
    email,
    app_origin: sp.app_origin ?? "",
    code_challenge: sp.code_challenge ?? "",
    state: sp.state ?? "",
  });
  const errorMessage = sp.error
    ? (ERRORS[sp.error] ?? "Enter the email address for your account.")
    : null;

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="If an account exists for that address, we've emailed a reset link."
        footer={
          <a
            className="underline underline-offset-2 hover:text-muted-foreground"
            href={`/login?${carry}`}
          >
            Back to sign in
          </a>
        }
      >
        <Alert aria-live="polite">
          The link expires in 15 minutes. Didn't get it? Check your spam folder, then try again.
        </Alert>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email and we'll send you a link to reset your password."
      footer={
        <a
          className="underline underline-offset-2 hover:text-muted-foreground"
          href={`/login?${carry}`}
        >
          Back to sign in
        </a>
      }
    >
      <form action={requestReset} noValidate>
        <input type="hidden" name="app_origin" value={sp.app_origin ?? ""} />
        <input type="hidden" name="code_challenge" value={sp.code_challenge ?? ""} />
        <input type="hidden" name="state" value={sp.state ?? ""} />
        <div className="mb-4">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
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
          Send reset link
        </Button>
      </form>
    </AuthShell>
  );
}
