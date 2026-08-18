// HistorySection.tsx — recent sign-in activity from the user's OWN sessions (device / IP / when), including
// signed-out ones, as a read-only login-history table. SSR + WCAG 2.2 AA (scoped table headers, sr-only caption).
//
// Scope note (per the spec): this is the per-user SESSION history. The cross-tenant auth-EVENT history
// (audit_log / platform_audit_log entries — login.success, mfa.challenge, etc.) is NOT surfaced here: those
// rows are tenant-scoped (audit_log) or platform-scoped (platform_audit_log) and a user can span 0/>1 tenants,
// so a clean per-user cross-tenant event read is out of scope for this increment (follow-up).
import { AccountSectionCard } from "@/shared/AccountShell";
import styles from "@/shared/auth.module.css";
import { StatusBadge } from "@leadwolf/ui";
import type { SessionView } from "./data";

export function HistorySection({ history }: { history: SessionView[] }) {
  const now = Date.now();
  return (
    <AccountSectionCard
      id="history"
      title="Login history"
      description="Recent sign-ins on your account. This shows session activity; the full event log is a follow-up."
    >
      {history.length === 0 ? (
        <p style={{ margin: 0, fontSize: 14, color: "var(--tp-ink-3)" }}>No recent sign-ins.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>Recent sign-ins</caption>
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">IP address</th>
                <th scope="col">Signed in</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => {
                const active = s.expiresAt.getTime() > now;
                return (
                  <tr key={s.id}>
                    <td>{s.device}</td>
                    <td className={styles.cellMono}>{s.ipAddress ?? "—"}</td>
                    <td className={styles.cellMuted}>{s.createdAt.toLocaleString()}</td>
                    <td>
                      <StatusBadge tone={active ? "success" : "muted"}>
                        {active ? "Active" : "Ended"}
                      </StatusBadge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AccountSectionCard>
  );
}
