// page.tsx — org selector (ADR-0019): shown when a global identity belongs to more than one org. Lists the
// user's active orgs as a radio group; choosing one sets the active tenant, then login continues to the
// workspace step or completes. Requires a pending login transaction (else back to /login). SSR + WCAG AA.
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { getLoginTransaction } from "@leadwolf/auth";
import { tenantMemberRepository } from "@leadwolf/db";
import { Alert, Button, RadioGroup, RadioOption } from "@leadwolf/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { selectOrg } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function OrgPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  const txn = txnId ? await getLoginTransaction(txnId) : null;
  if (!txn) redirect("/login");

  const orgs = await tenantMemberRepository.listForUser(txn.userId);

  return (
    <AuthShell title="Choose an organization" subtitle="You belong to more than one.">
      <form action={selectOrg}>
        <RadioGroup aria-label="Organizations" className="mb-4">
          {orgs.map((o, i) => (
            <RadioOption
              key={o.tenantId}
              name="tenantId"
              value={o.tenantId}
              defaultChecked={i === 0}
              required
            >
              <span>{o.tenantName}</span>
              {o.isTenantOwner ? (
                <span className="ml-auto text-xs text-[var(--tp-ink-4)]">owner</span>
              ) : null}
            </RadioOption>
          ))}
        </RadioGroup>
        {sp.error ? (
          <Alert variant="destructive" role="alert" className="mb-4">
            Please choose an organization.
          </Alert>
        ) : null}
        <Button type="submit" size="full">
          Continue
        </Button>
      </form>
    </AuthShell>
  );
}
