// page.tsx — Step 2B: the SSO handoff ("Your organization uses single sign-on"). Reached when the identifier
// step finds an SSO-enforced domain (existing or first-time user — the callback JIT-provisions). Continuing
// starts the IdP round-trip (17 §7). SSR, no-JS friendly; carries the tenant + the app's PKCE/return context.
import { AuthShell } from "@/shared/AuthShell";
import { Alert, Badge, Button } from "@leadwolf/ui";
import { initiateSso } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function SsoPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const tenant = sp.tenant ?? "";
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

  return (
    <AuthShell
      title="Single sign-on"
      subtitle="Your organization uses SSO. Continue to your identity provider to sign in."
      footer={
        <a
          className="underline underline-offset-2 hover:text-muted-foreground"
          href={`/login?${carry}`}
        >
          Use a different account
        </a>
      }
    >
      {email ? (
        <Badge className="mb-4">
          <span>{email}</span>
        </Badge>
      ) : null}
      <form action={initiateSso} noValidate>
        <input type="hidden" name="tenant" value={tenant} />
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="app_origin" value={appOrigin} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="state" value={state} />
        {sp.error ? (
          <Alert variant="destructive" role="alert" className="mb-4">
            Single sign-on isn&apos;t available right now. Contact your administrator or try another
            account.
          </Alert>
        ) : null}
        <Button type="submit" size="full">
          Continue to SSO
        </Button>
      </form>
    </AuthShell>
  );
}
