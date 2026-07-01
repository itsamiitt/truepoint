// DataHealthPage.tsx — the Data Health destination: a Tabs switcher (Overview · Re-verification activity · Retention)
// over the per-workspace data-quality rollups — headline metrics, per-field coverage, the freshness trend, and the
// email/phone verification breakdown — plus the daily re-verification activity and the tenant-wide retention-engine
// run audit (the SHADOW evidence). Every read is a workspace- or tenant-scoped, PII-safe GET /home/data-quality*
// endpoint. A pure composition shell. Public slice component.
"use client";

import { PageHeader } from "@/components/PageHeader";
import { Tabs, TpButton } from "@leadwolf/ui";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import styles from "../data-health.module.css";
import { useDataHealthMetrics } from "../hooks/useDataHealthMetrics";
import { useDataHealthTrend } from "../hooks/useDataHealthTrend";
import { useDuplicatePairs } from "../hooks/useDuplicatePairs";
import { useRetentionRuns } from "../hooks/useRetentionRuns";
import { useReverificationRuns } from "../hooks/useReverificationRuns";
import { useSessionRole } from "../hooks/useSessionRole";
import { DuplicatesSection } from "./DuplicatesSection";
import { FreshnessTrend } from "./FreshnessTrend";
import { MetricsSection } from "./MetricsSection";
import { PerFieldFill } from "./PerFieldFill";
import { RetentionActivity } from "./RetentionActivity";
import { ReverificationActivity } from "./ReverificationActivity";
import { ReverifyNowButton } from "./ReverifyNowButton";
import { SectionCard } from "./SectionCard";
import { SourceCoverageSection } from "./SourceCoverageSection";
import { VerificationBreakdown } from "./VerificationBreakdown";

type TabId = "overview" | "activity" | "retention" | "duplicates";

const TABS: { value: TabId; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "activity", label: "Re-verification activity" },
  { value: "retention", label: "Retention" },
  { value: "duplicates", label: "Duplicates" },
];

export function DataHealthPage() {
  const metrics = useDataHealthMetrics();
  const trend = useDataHealthTrend();
  const runs = useReverificationRuns();
  const retention = useRetentionRuns();
  const duplicates = useDuplicatePairs();
  const role = useSessionRole();
  const canReverify = role === "owner" || role === "admin";
  const [tab, setTab] = useState<TabId>("overview");

  const refreshing =
    metrics.loading || trend.loading || runs.loading || retention.loading || duplicates.loading;
  const reloadAll = () => {
    void metrics.reload();
    void trend.reload();
    void runs.reload();
    void retention.reload();
    void duplicates.reload();
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
          <SectionCard title="Source coverage" hint="Corroboration across sources">
            <SourceCoverageSection
              trend={trend.trend}
              loading={trend.loading}
              error={trend.error}
              onRetry={trend.reload}
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
      ) : null}

      {tab === "activity" ? (
        <div className={styles.sections}>
          <SectionCard title="Re-verification activity" hint="Daily freshness sweeps">
            <ReverifyNowButton
              canTrigger={canReverify}
              onQueued={() => window.setTimeout(() => void runs.reload(), 2000)}
            />
            <ReverificationActivity
              runs={runs.runs}
              loading={runs.loading}
              error={runs.error}
              onRetry={runs.reload}
            />
          </SectionCard>
        </div>
      ) : null}

      {tab === "retention" ? (
        <div className={styles.sections}>
          <SectionCard title="Retention activity" hint="Daily retention sweeps">
            <RetentionActivity
              runs={retention.runs}
              loading={retention.loading}
              error={retention.error}
              onRetry={retention.reload}
            />
          </SectionCard>
        </div>
      ) : null}

      {tab === "duplicates" ? (
        <div className={styles.sections}>
          <SectionCard title="Duplicate contacts" hint="Auto-detected — review & override">
            <DuplicatesSection
              pairs={duplicates.pairs}
              loading={duplicates.loading}
              error={duplicates.error}
              unmarking={duplicates.unmarking}
              onRetry={duplicates.reload}
              onUnmark={duplicates.unmark}
            />
          </SectionCard>
        </div>
      ) : null}
    </main>
  );
}
