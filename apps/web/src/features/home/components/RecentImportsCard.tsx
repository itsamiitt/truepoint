// RecentImportsCard.tsx — the latest CSV/source imports into this workspace: source name + file, contact
// count, and when it landed. Pure presentation over HomeSummary.recentImports; all four async states render
// through the shared WidgetCard → StateSwitch. Public slice component.
"use client";

import { Upload } from "lucide-react";
import type { RecentImport } from "../types";
import { formatRelative } from "./format";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

export function RecentImportsCard({
  imports,
  loading,
  error,
  onRetry,
}: {
  imports: RecentImport[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  return (
    <WidgetCard
      title="Recent imports"
      icon={Upload}
      loading={loading}
      error={error}
      empty={imports.length === 0}
      onRetry={onRetry}
      emptyIcon={Upload}
      emptyTitle="No imports yet"
      emptyDescription="Upload a CSV into this workspace and your most recent imports list here."
    >
      <div className={styles.list}>
        {imports.map((imp) => (
          <div key={`${imp.sourceName}-${imp.importedAt}`} className={styles.row}>
            <span className={styles.rowStack}>
              <span className={styles.rowLabel}>{imp.sourceFile ?? imp.sourceName}</span>
              <span className={styles.rowMeta}>{formatRelative(imp.importedAt)}</span>
            </span>
            <span className={styles.mono}>
              {imp.contactCount.toLocaleString()} contact{imp.contactCount === 1 ? "" : "s"}
            </span>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}
