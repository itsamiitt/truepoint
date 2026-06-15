// page.tsx — the in-app mock Identity Provider (DEVELOPMENT ONLY). It stands in for a real OIDC/SAML IdP so
// the SSO round-trip is exercisable locally: "authenticate" as an email, and it posts a signed assertion to
// the protocol callback. Disabled in production (the real IdP handles this). Requires a pending SSO transaction.
import { SSO_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { getSsoTransaction } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { Button, Input, Label } from "@leadwolf/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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
        <div className="mb-4">
          <Label htmlFor="email">Sign in as</Label>
          <Input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            defaultValue={txn.emailHint ?? ""}
            placeholder="you@company.com"
            required
            autoFocus
          />
        </div>
        <div className="mb-4">
          <Label htmlFor="full_name">
            Full name <span className="text-[var(--tp-ink-4)]">(optional)</span>
          </Label>
          <Input id="full_name" name="full_name" type="text" autoComplete="name" />
        </div>
        <Button type="submit" size="full">
          Authenticate
        </Button>
      </form>
    </AuthShell>
  );
}
