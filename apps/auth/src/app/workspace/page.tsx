// page.tsx — Step 4: the workspace selector (shown only when the user can access more than one). Lists the
// user's active workspaces (RLS-scoped read) as a radio group; choosing one completes login. Requires a
// pending login transaction (else back to /login). SSR + WCAG AA.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getLoginTransaction } from "@leadwolf/auth";
import { workspaceRepository } from "@leadwolf/db";
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { AuthShell } from "@/shared/AuthShell";
import { selectWorkspace } from "./actions";

type SearchParams = Promise<Record<string, string | undefined>>;

export default async function WorkspacePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  const txn = txnId ? await getLoginTransaction(txnId) : null;
  if (!txn) redirect("/login");

  const workspaces = await workspaceRepository.listForUser(txn.tenantId, txn.userId);

  return (
    <AuthShell title="Choose a workspace" subtitle="Select where you want to work.">
      <form action={selectWorkspace}>
        <div className="auth-field" role="radiogroup" aria-label="Workspaces">
          {workspaces.map((w, i) => (
            <label key={w.id} className="auth-radio">
              <input type="radio" name="workspaceId" value={w.id} defaultChecked={i === 0} required />
              <span>{w.name}</span>
              <span className="auth-radio-meta">{w.role}</span>
            </label>
          ))}
        </div>
        {sp.error ? (
          <p className="auth-error" role="alert">
            Please choose a workspace.
          </p>
        ) : null}
        <button className="auth-button" type="submit">
          Continue
        </button>
      </form>
    </AuthShell>
  );
}
