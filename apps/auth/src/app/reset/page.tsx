// page.tsx — the "set a new password" screen reached from the emailed reset link (17 §9). SSR, no-JS
// friendly: a new-password + confirm-password pair posts to the completeReset action; the email + single-use
// code ride as hidden fields. A bad/expired link or mismatched passwords re-render with a neutral error.
import { AuthShell } from "@/shared/AuthShell";
import { Alert, Button, Input, Label } from "@leadwolf/ui";
import { completeReset } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

const ERRORS: Record<string, string> = {
  mismatch: "Those passwords don't match. Try again.",
  weak: "Use at least 8 characters for your new password.",
};

export default async function ResetPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const email = sp.email ?? "";
  const code = sp.code ?? "";
  const appOrigin = sp.app_origin ?? "";
  const codeChallenge = sp.code_challenge ?? "";
  const state = sp.state ?? "";
  const errorMessage = sp.error
    ? (ERRORS[sp.error] ?? "This reset link is invalid or expired.")
    : null;

  return (
    <AuthShell title="Set a new password" subtitle="Choose a new password for your account.">
      <form action={completeReset} noValidate>
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="code" value={code} />
        <input type="hidden" name="app_origin" value={appOrigin} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="state" value={state} />
        <div className="mb-4">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            autoFocus
            aria-invalid={errorMessage ? "true" : undefined}
          />
        </div>
        <div className="mb-4">
          <Label htmlFor="confirm">Confirm new password</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            aria-invalid={errorMessage ? "true" : undefined}
          />
        </div>
        {errorMessage ? (
          <Alert variant="destructive" role="alert" className="mb-4">
            {errorMessage}
          </Alert>
        ) : null}
        <Button type="submit" size="full">
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}
