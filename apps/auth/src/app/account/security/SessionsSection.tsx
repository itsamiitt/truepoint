// SessionsSection.tsx — the user's OWN active sessions with revoke (one / all-others). "This device" is marked
// and never offered for revoke. SSR, no-JS friendly, WCAG 2.2 AA: a real table with scope="col" headers, each
// revoke is a labelled submit, and the destructive "sign out everywhere else" is clearly described. Reads are
// scoped to the authenticated user (data.ts); revokes are ownership-checked server-side (actions.ts).
import { AccountSectionCard } from "@/shared/AccountShell";
import { SubmitButton } from "@/shared/SubmitButton";
import { Alert, StatusBadge } from "@leadwolf/ui";
import { revokeAllOtherSessions, revokeOwnSession } from "./actions";
import type { SessionView } from "./data";
import type { StatusMessage } from "./status";

function sessionsStatusMessage(status: string | undefined): StatusMessage | null {
  switch (status) {
    case "revoked":
      return { tone: "ok", text: "That session was signed out." };
    case "others":
      return { tone: "ok", text: "All other sessions were signed out." };
    case "notfound":
      return { tone: "error", text: "That session is no longer active." };
    default:
      return null;
  }
}

export function SessionsSection({
  sessions,
  status,
}: {
  sessions: SessionView[];
  status?: string;
}) {
  const msg = sessionsStatusMessage(status);
  const others = sessions.filter((s) => !s.current);

  return (
    <AccountSectionCard
      id="sessions"
      title="Active sessions"
      description="Devices currently signed in to your account. Sign out any you don't recognize."
    >
      {msg ? (
        <Alert
          variant={msg.tone === "ok" ? "default" : "destructive"}
          role={msg.tone === "ok" ? "status" : "alert"}
          className="mb-4"
        >
          {msg.text}
        </Alert>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Your active sessions</caption>
          <thead>
            <tr className="text-[12px] text-[var(--tp-ink-3)]">
              <th scope="col" className="py-2 pr-3 font-medium">
                Device
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                IP address
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Last active
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="border-t border-[var(--tp-hairline-2)]">
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-2">
                    {s.device}
                    {s.current ? <StatusBadge tone="success">This device</StatusBadge> : null}
                  </span>
                </td>
                <td className="py-2 pr-3 font-mono text-[12px] text-[var(--tp-ink-3)]">
                  {s.ipAddress ?? "—"}
                </td>
                <td className="py-2 pr-3 text-[12px] text-[var(--tp-ink-3)]">
                  {(s.lastSeenAt ?? s.createdAt).toLocaleString()}
                </td>
                <td className="py-2 pr-3 text-right">
                  {s.current ? (
                    <span className="text-[12px] text-[var(--tp-ink-4)]">Current</span>
                  ) : (
                    <form action={revokeOwnSession}>
                      <input type="hidden" name="session_id" value={s.id} />
                      <button
                        type="submit"
                        className="text-[13px] text-destructive underline underline-offset-2 hover:opacity-80"
                      >
                        Sign out
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {others.length > 0 ? (
        <form action={revokeAllOtherSessions} className="mt-4 max-w-[260px]">
          <SubmitButton>Sign out all other sessions</SubmitButton>
        </form>
      ) : null}
    </AccountSectionCard>
  );
}
