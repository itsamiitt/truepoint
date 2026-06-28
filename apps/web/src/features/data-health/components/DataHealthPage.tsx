// DataHealthPage.tsx — the Data Health destination: a Tabs switcher (Overview · Re-verification activity) over the
// per-workspace data-quality rollups — headline metrics, per-field coverage, the freshness trend, and the email/
// phone verification breakdown — plus the daily re-verification activity. Every read is an EXISTING, workspace-
// scoped, PII-safe GET /home/data-quality* endpoint (no new backend). A pure composition shell. Public slice component.
"use client";

import { PageHeader } from "@/components/PageHeader";
import { Tabs, TpButton } from "@leadwolf/ui";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import styles from "../data-health.module.css";
import { useDataHealthMetrics } from "../hooks/useDataHealthMetrics";
import { useDataHealthTrend } from "../hooks/useDataHealthTrend";
import { useReverificationRuns } from "../hooks/useReverificationRuns";
import { FreshnessTrend } from "./FreshnessTrend";
import { MetricsSection } from "./MetricsSection";
import { PerFieldFill } from "./PerFieldFill";
import { ReverificationActivity } from "./ReverificationActivity";
import { SectionCard } from "./SectionCard";
import { VerificationBreakdown } from "./VerificationBreakdown";

type TabId = "overview" | "activity";

const TABS: { value: TabId; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "activity", label: "Re-verification activity" },
];

export function DataHealthPage() {
  const metrics = useDataHealthMetrics();
  const trend = useDataHealthTrend();
  const runs = useReverificationRuns();
  const [tab, setTab] = useState<TabId>("overview");

  const refreshing = metrics.loading || trend.loading || runs.loading;
  const reloadAll = () => {
    void metrics.reload();
    void trend.reload();
    void runs.reload();
  };

  return (
    <main className={styles.page}>
      <PageHeader
        title="Data Health"
        subtitle="Coverage, deliverability, and freshness across this workspace's contacts."
        actions={
          <TpButton
            variant="secondary"
            size="sm"
            leftIcon={<RefreshCw size={14} />}
            loading={refreshing}
            onClick={reloadAll}
          >
            Refresh
          </TpButton>
        }
      />

      <div className={styles.tabsRow}>
        <Tabs
          items={TABS}
          value={tab}
          onChange={(v) => setTab(v as TabId)}
          aria-label="Data Health views"
        />
      </div>

      {tab === "overview" ? (
        <div className={styles.sections}>
          <SectionCard title="Headline metrics" hint="Workspace rollup">
            <MetricsSection
              metrics={metrics.metrics}
              loading={metrics.loading}
              error={metrics.error}
              onRetry={metrics.reload}
            />
          </SectionCard>
          <SectionCard title="Field coverage" hint="Share with each field">
            <PerFieldFill
              metrics={metrics.metrics}
              loading={metrics.loading}
              error={metrics.error}
              onRetry={metrics.reload}
            />
          </SectionCard>
          <SectionCard title="Freshness trend" hint="Verified within SLA">
            <FreshnessTrend
              trend={trend.trend}
              loading={trend.loading}
              error={trend.error}
              onRetry={trend.reload}
            />
          </SectionCard>
          <SectionCard title="Verification breakdown" hint="Email & phone status">
            <VerificationBreakdown
              metrics={metrics.metrics}
              loading={metrics.loading}
              error={metrics.error}
              onRetry={metrics.reload}
            />
          </SectionCard>
        </div>
      ) : (
        <div className={styles.sections}>
          <SectionCard title="Re-verification activity" hint="Daily freshness sweeps">
            <ReverificationActivity
              runs={runs.runs}
              loading={runs.loading}
              error={runs.error}
              onRetry={runs.reload}
            />
          </SectionCard>
        </div>
      )}
    </main>
  );
}
