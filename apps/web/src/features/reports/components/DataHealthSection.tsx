// DataHealthSection.tsx — report section 3: contacts per email verification status (StatusBadge tones —
// the one place this page earns color) + the email-coverage line. Pure presentation over the health rollup.
"use client";

import { StatusBadge } from "@leadwolf/ui";
import styles from "../reports.module.css";
import type { DataHealthRollup } from "../types";

export function DataHealthSection({ rollup }: { rollup: DataHealthRollup }) {
  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Data health</h2>
        <p className={styles.cardHint}>Email verification across the workspace</p>
      </div>

      {rollup.total === 0 ? (
        <p className={styles.muted}>
          No contacts yet — data health appears once contacts are in the workspace.
        </p>
      ) : (
        <>
          <ul className={styles.healthList}>
            {rollup.rows.map((row) => (
              <li key={row.status} className={styles.healthRow}>
                <StatusBadge tone={row.tone}>{row.label}</StatusBadge>
                <span className={styles.healthCount}>{row.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>

          <p className={styles.coverage}>
            {rollup.withEmail.toLocaleString()} of {rollup.total.toLocaleString()} contact
            {rollup.total === 1 ? "" : "s"} have an email on file.
          </p>
        </>
      )}
    </section>
  );
}
