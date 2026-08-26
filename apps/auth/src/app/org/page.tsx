// page.tsx — org selector (ADR-0019): shown when a global identity belongs to more than one org. Lists the
// user's active orgs as a radio group; choosing one sets the active tenant, then login continues to the
// workspace step or completes. Requires a pending login transaction (else back to /login). SSR + WCAG AA.
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import styles from "@/shared/auth.module.css";
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
        <RadioGroup aria-label="Organizations" className={styles.spaced}>
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
                // ink-2, not ink-3 and certainly not the ink-4 this shipped with: a RadioOption fills with
                // --tp-surface-3 once it is :checked (and the first one is checked by default), where ink-3 is
                // 4.43:1 and ink-4 was 2.33:1 — both under AA. ink-2 holds at 9.4:1 checked and 12.6:1 not.
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: "var(--tp-text-caption)",
                    color: "var(--tp-ink-2)",
                  }}
                >
                  owner
                </span>
              ) : null}
            </RadioOption>
          ))}
        </RadioGroup>
        {sp.error ? (
          <Alert variant="destructive" role="alert" className={styles.spaced}>
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
