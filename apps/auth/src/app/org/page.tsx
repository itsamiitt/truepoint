// page.tsx — org selector (ADR-0019): shown when a global identity belongs to more than one org. Lists the
// user's active orgs as a radio group; choosing one sets the active tenant, then login continues to the
// workspace step or completes. Requires a pending login transaction (else back to /login). SSR + WCAG AA.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getLoginTransaction } from "@leadwolf/auth";
import { tenantMemberRepository } from "@leadwolf/db";
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
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
        <div className="auth-field" role="radiogroup" aria-label="Organizations">
          {orgs.map((o, i) => (
            <label key={o.tenantId} className="auth-radio">
              <input type="radio" name="tenantId" value={o.tenantId} defaultChecked={i === 0} required />
              <span>{o.tenantName}</span>
              {o.isTenantOwner ? <span className="auth-radio-meta">owner</span> : null}
            </label>
          ))}
        </div>
        {sp.error ? (
          <p className="auth-error" role="alert">
            Please choose an organization.
          </p>
        ) : null}
        <button className="auth-button" type="submit">
          Continue
        </button>
      </form>
    </AuthShell>
  );
}
