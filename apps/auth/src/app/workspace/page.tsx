// page.tsx — Step 4: the workspace selector (shown only when the user can access more than one). Lists the
// user's active workspaces (RLS-scoped read) as a radio group; choosing one completes login. Requires a
// pending login transaction (else back to /login). SSR + WCAG AA.
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import styles from "@/shared/auth.module.css";
import { getLoginTransaction } from "@leadwolf/auth";
import { workspaceRepository } from "@leadwolf/db";
import { Alert, Button, RadioGroup, RadioOption } from "@leadwolf/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { selectWorkspace } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function WorkspacePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  const txn = txnId ? await getLoginTransaction(txnId) : null;
  if (!txn) redirect("/login");
  if (!txn.tenantId) redirect("/org");

  const workspaces = await workspaceRepository.listForUser(txn.tenantId, txn.userId);

  return (
    <AuthShell title="Choose a workspace" subtitle="Select where you want to work.">
      <form action={selectWorkspace}>
        <RadioGroup aria-label="Workspaces" className={styles.spaced}>
          {workspaces.map((w, i) => (
            <RadioOption
              key={w.id}
              name="workspaceId"
              value={w.id}
              defaultChecked={i === 0}
              required
            >
              <span>{w.name}</span>
              {/* ink-2, not ink-3 and certainly not the ink-4 this shipped with: a RadioOption fills with
                  --tp-surface-3 once it is :checked (and the first one is checked by default), where ink-3 is
                  4.43:1 and ink-4 was 2.33:1 — both under AA. ink-2 holds at 9.4:1 checked and 12.6:1 not. */}
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: "var(--tp-text-caption)",
                  color: "var(--tp-ink-2)",
                }}
              >
                {w.role}
              </span>
            </RadioOption>
          ))}
        </RadioGroup>
        {sp.error ? (
          <Alert variant="destructive" role="alert" className={styles.spaced}>
            Please choose a workspace.
          </Alert>
        ) : null}
        <Button type="submit" size="full">
          Continue
        </Button>
      </form>
    </AuthShell>
  );
}
