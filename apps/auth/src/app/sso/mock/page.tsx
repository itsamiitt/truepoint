// page.tsx — the in-app mock Identity Provider (DEVELOPMENT ONLY). It stands in for a real OIDC/SAML IdP so
// the SSO round-trip is exercisable locally: "authenticate" as an email, and it posts a signed assertion to
// the protocol callback. Disabled in production (the real IdP handles this). Requires a pending SSO transaction.
import { SSO_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import styles from "@/shared/auth.module.css";
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
        <div className={styles.spaced}>
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
        <div className={styles.spaced}>
          <Label htmlFor="full_name">
            {/* ink-3, not ink-4: "(optional)" is part of the field's LABEL, so it is read as text. On the white
                AuthShell card ink-3 is 4.83:1 where ink-4 was 2.54:1. This matches signup/profile, which
                already spells the same "(optional)" in ink-3. */}
            Full name <span style={{ color: "var(--tp-ink-3)" }}>(optional)</span>
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
