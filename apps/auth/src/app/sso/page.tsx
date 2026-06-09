// page.tsx — Step 2B: the SSO handoff ("Your organization uses single sign-on"). Reached when the identifier
// step finds an SSO-enforced domain (existing or first-time user — the callback JIT-provisions). Continuing
// starts the IdP round-trip (17 §7). SSR, no-JS friendly; carries the tenant + the app's PKCE/return context.
import { AuthShell } from "@/shared/AuthShell";
import { initiateSso } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function SsoPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const tenant = sp.tenant ?? "";
  const email = sp.email ?? "";
  const appOrigin = sp.app_origin ?? "";
  const codeChallenge = sp.code_challenge ?? "";
  const state = sp.state ?? "";
  const carry = new URLSearchParams({ email, app_origin: appOrigin, code_challenge: codeChallenge, state });

  return (
    <AuthShell
      title="Single sign-on"
      subtitle="Your organization uses SSO. Continue to your identity provider to sign in."
      footer={
        <a className="auth-link" href={`/login?${carry}`}>
          Use a different account
        </a>
      }
    >
      {email ? (
        <div className="auth-chip">
          <span>{email}</span>
        </div>
      ) : null}
      <form action={initiateSso} noValidate>
        <input type="hidden" name="tenant" value={tenant} />
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="app_origin" value={appOrigin} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="state" value={state} />
        {sp.error ? (
          <p className="auth-error" role="alert">
            Single sign-on isn&apos;t available right now. Contact your administrator or try another account.
          </p>
        ) : null}
        <button className="auth-button" type="submit">
          Continue to SSO
        </button>
      </form>
    </AuthShell>
  );
}
