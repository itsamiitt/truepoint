// UsageTable.tsx — presentation of the credit usage history (one row per metered reveal). Pure
// presentation: data comes from useBilling via the parent; the credit accounting is server-side (07 §3).

import type { UsageReveal } from "../api";
import styles from "../billing.module.css";

const REVEAL_LABEL: Record<string, string> = {
  email: "Email",
  phone: "Phone",
  full_profile: "Full profile",
};

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function UsageTable({ reveals }: { reveals: UsageReveal[] }) {
  if (reveals.length === 0) {
    return (
      <p className={styles.muted}>
        No reveals yet. When you reveal a contact, each charge shows up here — fully itemized.
      </p>
    );
  }
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Reveal</th>
            <th>Type</th>
            <th>Credits</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {reveals.map((r) => (
            <tr key={r.id}>
              <td className={styles.mono}>{shortId(r.id)}</td>
              <td>
                <span className={styles.typeBadge}>
                  {REVEAL_LABEL[r.revealType] ?? r.revealType}
                </span>
              </td>
              <td className={styles.credits}>{r.creditsConsumed}</td>
              <td>{formatDate(r.revealedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
