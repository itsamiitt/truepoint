// HomePage.tsx — the Home cockpit: a row of KPI StatTiles (tenant credit pool · recent reveals · verified-
// data billing) over a responsive widget grid (tasks, replies, reveals, hot leads, this-workspace burn,
// sequences, imports, enrichment, activity feed). A pure composition shell — each widget is a small
// co-located card that wraps its async content in the State Kit; data comes from useHomeSummary in one call.
// Monochrome; color appears only via StatusBadge tones. Public slice component.
"use client";

import { PageHeader } from "@/components/PageHeader";
import { Skeleton, StatTile, StatusBadge, TpButton } from "@leadwolf/ui";
import { RefreshCw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useDataQuality } from "../hooks/useDataQuality";
import { useDataQualityTrend } from "../hooks/useDataQualityTrend";
import { useHomeSummary } from "../hooks/useHomeSummary";
import { ActivityFeedCard } from "./ActivityFeedCard";
import { BurnSparkline } from "./BurnSparkline";
import { DataHealthCard } from "./DataHealthCard";
import { DataHealthTrendCard } from "./DataHealthTrendCard";
import { EnrichmentActivityCard } from "./EnrichmentActivityCard";
import styles from "./HomePage.module.css";
import { HotLeadsCard } from "./HotLeadsCard";
import { QuickActionsRow } from "./QuickActionsRow";
import { RecentImportsCard } from "./RecentImportsCard";
import { RecentRevealsCard } from "./RecentRevealsCard";
import { RepliesCard } from "./RepliesCard";
import { SequenceSnapshot } from "./SequenceSnapshot";
import { TasksCard } from "./TasksCard";

/** The KPI value while the first load is in flight: a calm skeleton, not a spinner, per the State Kit. */
function tileValue(loading: boolean, ready: boolean, value: ReactNode): ReactNode {
  return loading && !ready ? <Skeleton width={72} height={28} /> : value;
}

/** White, hairline-bordered KPI card with the one whisper-soft shadow (Brand Kit cards float on the canvas). */
const KPI_CARD: CSSProperties = {
  background: "var(--tp-surface)",
  border: "1px solid var(--tp-hairline-2)",
  borderRadius: "var(--tp-radius-card)",
  boxShadow: "var(--tp-shadow-card)",
};

export function HomePage() {
  const { summary, error, loading, reload } = useHomeSummary();
  const dq = useDataQuality();
  const dqTrend = useDataQualityTrend();

  const ready = summary != null;
  const balance = summary?.creditBalance ?? null;
  // Matches CreditPill / useNotifications LOW_BALANCE so the tile, pill, and bell agree on "low".
  const lowBalance = balance != null && balance < 20;

  const reveals = summary?.recentReveals ?? [];
  const revealCredits = reveals.reduce((sum, r) => sum + r.creditsConsumed, 0);

  return (
    <main className={styles.page}>
      <div className={styles.inner}>
        <PageHeader
          eyebrow="Workspace overview"
          title="Home"
          subtitle="Your workspace at a glance."
          actions={
            <TpButton
              variant="secondary"
              size="sm"
              leftIcon={<RefreshCw size={14} />}
              loading={loading}
              onClick={() => void reload()}
            >
              Refresh
            </TpButton>
          }
        />

        <QuickActionsRow />

        <section className={styles.tiles}>
          <StatTile
            style={KPI_CARD}
            label={<span className={styles.kpiLabel}>Credit balance</span>}
            value={tileValue(loading, ready, (balance ?? "—").toLocaleString())}
            sublabel={
              lowBalance
                ? "Tenant pool running low — top up to keep revealing."
                : "Shared tenant credit pool"
            }
            trend={
              balance != null ? (
                <StatusBadge tone={lowBalance ? "warning" : "success"}>
                  {lowBalance ? "Low" : "Healthy"}
                </StatusBadge>
              ) : undefined
            }
          />
          <StatTile
            style={KPI_CARD}
            label={<span className={styles.kpiLabel}>Recent reveals</span>}
            value={tileValue(loading, ready, reveals.length)}
            sublabel={
              revealCredits > 0
                ? `${revealCredits.toLocaleString()} credit${revealCredits === 1 ? "" : "s"} across your last reveals`
                : "Verified emails & phones you've revealed"
            }
          />
          <StatTile
            style={KPI_CARD}
            label={<span className={styles.kpiLabel}>Verified-data billing</span>}
            value="Pay per result"
            sublabel="You're only charged when a reveal returns verified data — never for a miss."
          />
        </section>

        <section className={`${styles.grid} ${styles.enter}`}>
          <TasksCard
            tasks={summary?.todaysTasks ?? []}
            loading={loading}
            error={error}
            onRetry={reload}
          />
          <RepliesCard
            replies={summary?.recentReplies ?? []}
            loading={loading}
            error={error}
            onRetry={reload}
          />
          <RecentRevealsCard reveals={reveals} loading={loading} error={error} onRetry={reload} />
          <HotLeadsCard
            leads={summary?.hotLeads ?? []}
            loading={loading}
            error={error}
            onRetry={reload}
          />
          <DataHealthCard
            metrics={dq.metrics}
            loading={dq.loading}
            error={dq.error}
            onRetry={dq.reload}
          />
          <DataHealthTrendCard
            trend={dqTrend.trend}
            loading={dqTrend.loading}
            error={dqTrend.error}
            onRetry={dqTrend.reload}
          />
          <BurnSparkline
            burn={summary?.burn ?? []}
            loading={loading}
            error={error}
            onRetry={reload}
          />
          <SequenceSnapshot
            snapshot={summary?.sequenceSnapshot ?? null}
            loading={loading}
            error={error}
            onRetry={reload}
          />
          <RecentImportsCard
            imports={summary?.recentImports ?? []}
            loading={loading}
            error={error}
            onRetry={reload}
          />
          <EnrichmentActivityCard
            activity={summary?.enrichmentActivity ?? []}
            loading={loading}
            error={error}
            onRetry={reload}
          />
          <div className={styles.spanFull}>
            <ActivityFeedCard
              items={summary?.activityFeed ?? []}
              loading={loading}
              error={error}
              onRetry={reload}
            />
          </div>
        </section>
      </div>
    </main>
  );
}
