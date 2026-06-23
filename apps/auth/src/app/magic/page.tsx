// page.tsx — the magic-link confirmation screen (17 §2/§9). Reached when the identifier step routes an email
// to passwordless sign-in. SSR, no-JS friendly: the email shows as a Badge and a primary button posts to the
// sendMagic action to mail a one-click link. After sending it switches to "check your email" + a resend
// button (rate-limited server-side). Carries the app's PKCE/return context as hidden fields.
import { redirectIfAuthenticated } from "@/lib/sessionGuard";
import { AuthShell } from "@/shared/AuthShell";
import { SubmitButton } from "@/shared/SubmitButton";
import { Alert, Badge, Button } from "@leadwolf/ui";
import { sendMagic } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

const ERRORS: Record<string, string> = {
  rate: "Too many attempts. Wait a moment and try again.",
};

export default async function MagicPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  await redirectIfAuthenticated(sp.app_origin);
  const email = sp.email ?? "";
  const appOrigin = sp.app_origin ?? "";
  const codeChallenge = sp.code_challenge ?? "";
  const state = sp.state ?? "";
  const sent = sp.sent === "1";
  const carry = new URLSearchParams({
    email,
    app_origin: appOrigin,
    code_challenge: codeChallenge,
    state,
  });
  const errorMessage = sp.error ? (ERRORS[sp.error] ?? "Something went wrong. Try again.") : null;

  const hidden = (
    <>
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="app_origin" value={appOrigin} />
      <input type="hidden" name="code_challenge" value={codeChallenge} />
      <input type="hidden" name="state" value={state} />
    </>
  );

  return (
    <AuthShell
      title={sent ? "Check your email" : "Sign in with a magic link"}
      subtitle={
        sent
          ? "We emailed you a secure link. Open it on this device to finish signing in."
          : "We'll email you a one-click link to sign in — no password needed."
      }
      footer={
        <a
          className="underline underline-offset-2 hover:text-muted-foreground"
          href={`/login?${carry}`}
        >
          Use a different account
        </a>
      }
    >
      <Badge className="mb-4">
        <span>{email || "your account"}</span>
      </Badge>

      {errorMessage ? (
        <Alert variant="destructive" role="alert" className="mb-4 tp-shake">
          {errorMessage}
        </Alert>
      ) : null}

      {sent ? (
        <>
          <Alert aria-live="polite" className="mb-4">
            The link expires in 15 minutes. Didn't get it? Check your spam folder, then resend.
          </Alert>
          <form action={sendMagic} noValidate>
            {hidden}
            <Button type="submit" variant="outline" size="full">
              Resend link
            </Button>
          </form>
        </>
      ) : (
        <form action={sendMagic} noValidate>
          {hidden}
          <SubmitButton>Send sign-in link</SubmitButton>
        </form>
      )}
    </AuthShell>
  );
}
