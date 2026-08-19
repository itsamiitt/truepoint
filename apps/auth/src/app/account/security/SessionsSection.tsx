// SessionsSection.tsx — the user's OWN active sessions with revoke (one / all-others). "This device" is marked
// and never offered for revoke. SSR, no-JS friendly, WCAG 2.2 AA: a real table with scope="col" headers, each
// revoke is a labelled submit, and the destructive "sign out everywhere else" is clearly described. Reads are
// scoped to the authenticated user (data.ts); revokes are ownership-checked server-side (actions.ts).
import { AccountSectionCard } from "@/shared/AccountShell";
import { SubmitButton } from "@/shared/SubmitButton";
import styles from "@/shared/auth.module.css";
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
          className={styles.spaced}
        >
          {msg.text}
        </Alert>
      ) : null}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className={styles.srOnly}>Your active sessions</caption>
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col">IP address</th>
              <th scope="col">Last active</th>
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--tp-space-2)",
                    }}
                  >
                    {s.device}
                    {s.current ? <StatusBadge tone="success">This device</StatusBadge> : null}
                  </span>
                </td>
                <td className={styles.cellMono}>{s.ipAddress ?? "—"}</td>
                <td className={styles.cellMuted}>
                  {(s.lastSeenAt ?? s.createdAt).toLocaleString()}
                </td>
                <td className={styles.cellRight}>
                  {s.current ? (
                    <span style={{ fontSize: 12, color: "var(--tp-ink-4)" }}>Current</span>
                  ) : (
                    <form action={revokeOwnSession}>
                      <input type="hidden" name="session_id" value={s.id} />
                      <button type="submit" className={styles.linkDanger}>
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
        <form
          action={revokeAllOtherSessions}
          style={{ marginTop: "var(--tp-space-4)", maxWidth: 260 }}
        >
          <SubmitButton>Sign out all other sessions</SubmitButton>
        </form>
      ) : null}
    </AccountSectionCard>
  );
}
