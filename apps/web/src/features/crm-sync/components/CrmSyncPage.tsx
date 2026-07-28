// CrmSyncPage.tsx — the customer-facing CRM sync surface (crm-sync 00 §9). A destination view over the
// workspace-scoped read endpoints: connections, their recent runs, and the conflict review queue.
//
// It renders the SYNC MODE prominently because that is the single fact a customer most needs: a connection
// in `shadow` is connected and counting but has written nothing to their CRM, and a page that showed only
// "Connected" would be actively misleading about whether their data is moving.
"use client";

import { Card, Icon, StatusBadge, type StatusTone, TpButton } from "@leadwolf/ui";
import { Plug } from "lucide-react";
import { useState } from "react";
import styles from "../crm-sync.module.css";
import { useCrmConflicts } from "../hooks/useCrmConflicts";
import { useCrmConnections } from "../hooks/useCrmConnections";
import { useCrmRuns } from "../hooks/useCrmRuns";
import { ConflictQueue } from "./ConflictQueue";
import { SyncActivity } from "./SyncActivity";

const MODE_TONE: Record<string, StatusTone> = {
  disabled: "muted",
  shadow: "warning",
  enforce: "success",
};

// Paired with the badge so the state is never conveyed by colour alone (WCAG 2.2 AA).
const MODE_LABEL: Record<string, string> = {
  disabled: "Paused",
  shadow: "Preview only",
  enforce: "Syncing",
};

export function CrmSyncPage() {
  const { connections, loading, error, reload } = useCrmConnections();
  const [selected, setSelected] = useState<string | null>(null);
  const activeId = selected ?? connections?.[0]?.id ?? null;

  const runs = useCrmRuns(activeId);
  const conflicts = useCrmConflicts();

  return (
    <div className={styles.stack}>
      <Card>
        <div className={styles.stack}>
          <h2 className={styles.subheading}>Connections</h2>
          {loading && <p className={styles.footnote}>Loading your CRM connections…</p>}
          {error && <p className={styles.footnote}>{error}</p>}
          {!loading && !error && (connections?.length ?? 0) === 0 && (
            <p className={styles.footnote}>
              <Icon icon={Plug} size={16} /> No CRM connected yet.
            </p>
          )}
          {(connections ?? []).map((conn) => (
            <div key={conn.id} className={styles.connectionRow}>
              <TpButton
                variant={conn.id === activeId ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={conn.id === activeId}
                onClick={() => setSelected(conn.id)}
              >
                {conn.provider}
              </TpButton>
              <StatusBadge tone={MODE_TONE[conn.syncMode] ?? "muted"}>
                {MODE_LABEL[conn.syncMode] ?? conn.syncMode}
              </StatusBadge>
              <span className={styles.footnote}>{conn.externalAccountId ?? "—"}</span>
              {conn.lastError && <span className={styles.footnote}>{conn.lastError}</span>}
            </div>
          ))}
          <p className={styles.footnote}>
            Preview only means we are reading and counting, but nothing has been written to your CRM
            yet.
          </p>
          <div className={styles.actions}>
            <TpButton variant="ghost" size="sm" onClick={reload}>
              Refresh
            </TpButton>
          </div>
        </div>
      </Card>

      <Card>
        <SyncActivity
          runs={runs.runs}
          loading={runs.loading}
          error={runs.error}
          onRetry={runs.reload}
        />
      </Card>

      <Card>
        <ConflictQueue
          conflicts={conflicts.conflicts}
          loading={conflicts.loading}
          error={conflicts.error ?? conflicts.resolveError}
          resolving={conflicts.resolving}
          onResolve={conflicts.resolve}
          onRetry={conflicts.reload}
        />
      </Card>
    </div>
  );
}
