// HomePage.tsx — the Home cockpit: a row of KPI StatTiles (tenant credit pool · recent reveals · verified-
// data billing) over a widget grid (recent reveals, hot leads, this-workspace burn, imports, enrichment,
// sequences, activity feed). A pure composition shell — each widget is a small co-located card; data comes
// from useHomeSummary. Monochrome; color appears only via StatusBadge tones. Public slice component.
"use client";

import { Spinner, StatTile, StatusBadge } from "@leadwolf/ui";
import { useHomeSummary } from "../hooks/useHomeSummary";
import { ActivityFeedCard } from "./ActivityFeedCard";
import { BurnSparkline } from "./BurnSparkline";
import { EnrichmentActivityCard } from "./EnrichmentActivityCard";
import styles from "./HomePage.module.css";
import { HotLeadsCard } from "./HotLeadsCard";
import { QuickActionsRow } from "./QuickActionsRow";
import { RecentImportsCard } from "./RecentImportsCard";
import { RecentRevealsCard } from "./RecentRevealsCard";
import { RepliesCard } from "./RepliesCard";
import { SequenceSnapshot } from "./SequenceSnapshot";
import { TasksCard } from "./TasksCard";

export function HomePage() {
  const { summary, error, loading } = useHomeSummary();

  const balance = summary?.creditBalance ?? null;
  // Matches CreditPill / useNotifications LOW_BALANCE so the tile, pill, and bell agree on "low".
  const lowBalance = balance != null && balance < 20;

  return (
    <main className={styles.page}>
      <header className={styles.heading}>
        <h1 className={styles.title}>Home</h1>
        <p className={styles.subtitle}>Your workspace at a glance.</p>
      </header>

      <QuickActionsRow />

      <section className={styles.tiles}>
        <StatTile
          label="Credit balance"
          value={
            loading && balance == null ? <Spinner size={20} /> : (balance ?? "—").toLocaleString()
          }
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
          label="Recent reveals"
          value={
            loading && summary == null ? (
              <Spinner size={20} />
            ) : (
              (summary?.recentReveals.length ?? 0)
            )
          }
          sublabel="In your last 10 of activity"
        />
        <StatTile
          label="Verified-data billing"
          value="Pay per result"
          sublabel="You're only charged when a reveal returns verified data — never for a miss."
        />
      </section>

      <section className={styles.grid}>
        <TasksCard tasks={summary?.todaysTasks ?? []} loading={loading} error={error} />
        <RepliesCard replies={summary?.recentReplies ?? []} loading={loading} error={error} />
        <RecentRevealsCard reveals={summary?.recentReveals ?? []} loading={loading} error={error} />
        <HotLeadsCard leads={summary?.hotLeads ?? []} loading={loading} error={error} />
        <BurnSparkline burn={summary?.burn ?? []} loading={loading} error={error} />
        <SequenceSnapshot
          snapshot={summary?.sequenceSnapshot ?? null}
          loading={loading}
          error={error}
        />
        <RecentImportsCard imports={summary?.recentImports ?? []} loading={loading} error={error} />
        <EnrichmentActivityCard
          activity={summary?.enrichmentActivity ?? []}
          loading={loading}
          error={error}
        />
        <div className={styles.spanFull}>
          <ActivityFeedCard items={summary?.activityFeed ?? []} loading={loading} error={error} />
        </div>
      </section>
    </main>
  );
}
