// UsageTab.tsx — the billing hub's Usage tab: keyset-paginated, filterable credit-usage history with a
// "Load more" cursor and CSV export, on the foundation DataTable. Owns its own data (useUsageHistory) so it's
// independent of the Plan/Credits load. The reveal accounting is server-side (07 §3).
"use client";

import { Card, EmptyState, StateSwitch, TpButton, TpSelect } from "@leadwolf/ui";
import { Download } from "lucide-react";
import styles from "../../billing.module.css";
import { useUsageHistory } from "../../hooks/useUsageHistory";
import type { RevealDataSource, RevealType } from "../../types";
import { UsageTable } from "../UsageTable";

export function UsageTab() {
  const {
    rows,
    filters,
    setFilters,
    loading,
    loadingMore,
    exporting,
    error,
    hasMore,
    loadMore,
    exportCsv,
    reload,
  } = useUsageHistory();

  return (
    <Card style={{ padding: 24 }}>
      <div className={styles.cardHead}>
        <span className={styles.cardLabel}>Usage history</span>
        <div className={styles.usageControls}>
          <TpSelect
            aria-label="Filter by reveal type"
            value={filters.revealType ?? ""}
            onChange={(e) =>
              setFilters({
                ...filters,
                revealType: (e.target.value || undefined) as RevealType | undefined,
              })
            }
          >
            <option value="">All types</option>
            <option value="email">Email</option>
            <option value="phone">Phone</option>
            <option value="full_profile">Full profile</option>
          </TpSelect>
          <TpSelect
            aria-label="Filter by data source"
            value={filters.dataSource ?? ""}
            onChange={(e) =>
              setFilters({
                ...filters,
                dataSource: (e.target.value || undefined) as RevealDataSource | undefined,
              })
            }
          >
            <option value="">All sources</option>
            <option value="apollo">Apollo</option>
            <option value="zoominfo">ZoomInfo</option>
            <option value="linkedin">LinkedIn</option>
            <option value="internal">Internal</option>
          </TpSelect>
          <TpButton
            variant="ghost"
            size="sm"
            leftIcon={<Download size={14} />}
            loading={exporting}
            disabled={rows.length === 0}
            onClick={() => void exportCsv()}
          >
            Export
          </TpButton>
        </div>
      </div>
      <StateSwitch
        loading={loading}
        error={error}
        onRetry={reload}
        empty={rows.length === 0}
        emptyState={
          <EmptyState
            title="No reveals match"
            description="When you reveal a contact, each charge shows up here — fully itemized. Adjust the filters to widen the view."
          />
        }
      >
        <UsageTable reveals={rows} />
        {hasMore && (
          <div className={styles.loadMore}>
            <TpButton
              variant="secondary"
              size="sm"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              Load more
            </TpButton>
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}
