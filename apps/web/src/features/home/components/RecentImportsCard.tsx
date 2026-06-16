// RecentImportsCard.tsx — the latest CSV/source imports into this workspace: source name + file, contact
// count, and when it landed. Pure presentation over HomeSummary.recentImports; calm empty/loading/error.
"use client";

import { Card, Spinner } from "@leadwolf/ui";
import type { RecentImport } from "../types";
import styles from "./HomePage.module.css";
import { formatDate } from "./format";

export function RecentImportsCard({
  imports,
  loading,
  error,
}: {
  imports: RecentImport[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <Card>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Recent imports</h2>
      </div>
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : loading ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading imports…
        </div>
      ) : imports.length === 0 ? (
        <p className={styles.muted}>
          No imports yet. Upload a CSV into this workspace and it will show up here.
        </p>
      ) : (
        <div className={styles.list}>
          {imports.map((imp) => (
            <div key={`${imp.sourceName}-${imp.importedAt}`} className={styles.row}>
              <span className={styles.rowStack}>
                <span className={styles.rowLabel}>{imp.sourceFile ?? imp.sourceName}</span>
                <span className={styles.rowMeta}>{formatDate(imp.importedAt)}</span>
              </span>
              <span className={styles.mono}>
                {imp.contactCount.toLocaleString()} contact{imp.contactCount === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
