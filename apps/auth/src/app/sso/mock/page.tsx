// page.tsx — the in-app mock Identity Provider (DEVELOPMENT ONLY). It stands in for a real OIDC/SAML IdP so
// the SSO round-trip is exercisable locally: "authenticate" as an email, and it posts a signed assertion to
// the protocol callback. Disabled in production (the real IdP handles this). Requires a pending SSO transaction.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSsoTransaction } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { SSO_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { submitMockAssertion } from "./actions";

export default async function MockIdpPage() {
  if (env.NODE_ENV === "production") redirect("/login");
  const txnId = (await cookies()).get(SSO_TXN_COOKIE)?.value;
  const txn = txnId ? await getSsoTransaction(txnId) : null;
  if (!txn) redirect("/login");

  return (
    <AuthShell
      title="Mock identity provider"
      subtitle="Development only — this stands in for your organization's real SSO login."
    >
      <form action={submitMockAssertion} noValidate>
        <div className="auth-field">
          <label className="auth-label" htmlFor="email">
            Sign in as
          </label>
          <input
            className="auth-input"
            id="email"
            name="email"
            type="email"
            inputMode="email"
            defaultValue={txn.emailHint ?? ""}
            placeholder="you@company.com"
            required
            // biome-ignore lint/a11y/noAutofocus: single primary field focuses by design
            autoFocus
          />
        </div>
        <div className="auth-field">
          <label className="auth-label" htmlFor="full_name">
            Full name <span className="auth-label-hint">(optional)</span>
          </label>
          <input className="auth-input" id="full_name" name="full_name" type="text" autoComplete="name" />
        </div>
        <button className="auth-button" type="submit">
          Authenticate
        </button>
      </form>
    </AuthShell>
  );
}
