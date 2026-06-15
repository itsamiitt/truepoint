// page.tsx — Registration step 3: set the profile (full name, optional username alias, password) after the
// email is proven (ADR-0020). Requires an email-verified signup transaction (else back to /signup or /verify).
// Submitting provisions the global identity + its org placement and completes the login. SSR + WCAG AA.
import { SIGNUP_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { getSignupTransaction } from "@leadwolf/auth";
import { Alert, Badge, Button, Input, Label } from "@leadwolf/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { completeSignup } from "../actions";

type SearchParams = Promise<Record<string, string | undefined>>;

const ERRORS: Record<string, string> = {
  username: "That username is taken. Try another.",
  invalid: "Check the form and try again. Passwords need at least 8 characters.",
};

export default async function ProfilePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const txnId = (await cookies()).get(SIGNUP_TXN_COOKIE)?.value;
  const txn = txnId ? await getSignupTransaction(txnId) : null;
  if (!txn) redirect("/signup");
  if (!txn.emailVerified) redirect("/verify");
  const errorMessage = sp.error ? (ERRORS[sp.error] ?? "Something went wrong. Try again.") : null;

  return (
    <AuthShell title="Finish setting up" subtitle="A few details and you're in.">
      <Badge className="mb-4">
        <span>{txn.email}</span>
      </Badge>

      <form action={completeSignup} noValidate>
        <div className="mb-4">
          <Label htmlFor="full_name">Full name</Label>
          <Input
            id="full_name"
            name="full_name"
            type="text"
            autoComplete="name"
            required
            autoFocus
          />
        </div>
        <div className="mb-4">
          <Label htmlFor="username">
            Username <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            pattern="[a-zA-Z0-9_.\-]{3,32}"
            aria-invalid={sp.error === "username" ? "true" : undefined}
          />
        </div>
        <div className="mb-4">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            aria-invalid={sp.error === "invalid" ? "true" : undefined}
          />
        </div>
        {errorMessage ? (
          <Alert variant="destructive" role="alert" className="mb-4">
            {errorMessage}
          </Alert>
        ) : null}
        <Button type="submit" size="full">
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
