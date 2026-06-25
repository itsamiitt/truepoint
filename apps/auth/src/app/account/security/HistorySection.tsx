// HistorySection.tsx — recent sign-in activity from the user's OWN sessions (device / IP / when), including
// signed-out ones, as a read-only login-history table. SSR + WCAG 2.2 AA (scoped table headers, sr-only caption).
//
// Scope note (per the spec): this is the per-user SESSION history. The cross-tenant auth-EVENT history
// (audit_log / platform_audit_log entries — login.success, mfa.challenge, etc.) is NOT surfaced here: those
// rows are tenant-scoped (audit_log) or platform-scoped (platform_audit_log) and a user can span 0/>1 tenants,
// so a clean per-user cross-tenant event read is out of scope for this increment (follow-up).
import { AccountSectionCard } from "@/shared/AccountShell";
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
        <p className="text-sm text-[var(--tp-ink-3)]">No recent sign-ins.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Recent sign-ins</caption>
            <thead>
              <tr className="text-[12px] text-[var(--tp-ink-3)]">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Device
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  IP address
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Signed in
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => {
                const active = s.expiresAt.getTime() > now;
                return (
                  <tr key={s.id} className="border-t border-[var(--tp-hairline-2)]">
                    <td className="py-2 pr-3">{s.device}</td>
                    <td className="py-2 pr-3 font-mono text-[12px] text-[var(--tp-ink-3)]">
                      {s.ipAddress ?? "—"}
                    </td>
                    <td className="py-2 pr-3 text-[12px] text-[var(--tp-ink-3)]">
                      {s.createdAt.toLocaleString()}
                    </td>
                    <td className="py-2 pr-3">
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
