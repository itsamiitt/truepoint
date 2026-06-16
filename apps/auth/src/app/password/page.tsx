// page.tsx — Step 2A: the password screen. Email shows as a locked chip with a "change" back-link; the
// PKCE/return context rides as hidden fields. SSR, no-JS friendly, keyboard-first, WCAG AA. Show/hide and
// passkey prompt are progressive enhancements layered on top of this base render.
import { AuthShell } from "@/shared/AuthShell";
import { SubmitButton } from "@/shared/SubmitButton";
import { Alert, Badge, Input, Label } from "@leadwolf/ui";
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
        <a
          className="underline underline-offset-2 hover:text-muted-foreground"
          href={`/forgot?${carry}`}
        >
          Forgot password?
        </a>
      }
    >
      <Badge className="mb-4">
        <span>{email || "your account"}</span>
        <a
          className="underline underline-offset-2 hover:text-muted-foreground"
          href={`/login?${carry}`}
        >
          change
        </a>
      </Badge>

      <form action={submitPassword} noValidate>
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="app_origin" value={sp.app_origin ?? ""} />
        <input type="hidden" name="code_challenge" value={sp.code_challenge ?? ""} />
        <input type="hidden" name="state" value={sp.state ?? ""} />
        <div className="mb-4">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            aria-invalid={sp.error ? "true" : undefined}
          />
        </div>
        {sp.error ? (
          <Alert variant="destructive" role="alert" className="mb-4 tp-shake">
            {sp.error === "unavailable"
              ? "Sign-in is temporarily unavailable. Please try again in a moment."
              : "Check your credentials and try again."}
          </Alert>
        ) : null}
        <SubmitButton>Sign in</SubmitButton>
      </form>
    </AuthShell>
  );
}
