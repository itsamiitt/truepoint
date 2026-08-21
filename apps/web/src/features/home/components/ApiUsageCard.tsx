// ApiUsageCard.tsx — public-API consumption on the cockpit (ADR-0049). Calls, billed calls and credits over
// the last 30 days, with a sparkline for the shape.
//
// The data hook and the sparkline come from features/api-usage through its PUBLIC index; only the cockpit
// framing lives here, because WidgetCard is internal to this slice. That is the boundary rule choosing the
// direction, and it is the right one — the usage feature knows nothing about the cockpit.
//
// The three figures are chosen to make ONE promise checkable: "no match, no charge". Calls and billed calls
// side by side let a customer see their own no-match rate rather than take our word for it. A single
// "requests" number would have hidden exactly the thing worth showing.
"use client";

import { UsageSparkline, useApiUsage } from "@/features/api-usage";
import { Plug } from "lucide-react";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

const WINDOW_DAYS = 30;

export function ApiUsageCard() {
  const { feed, error, loading, reload } = useApiUsage(WINDOW_DAYS);

  const usage = feed?.usage ?? null;
  const totals = usage?.totals ?? null;
  // "Not wired" and "wired but unused" are different states with different next steps — switch it on, or
  // integrate. Collapsing them into one empty state would send a customer to the wrong place.
  const unavailable = feed !== null && !feed.available;
  const empty = unavailable || (totals?.calls ?? 0) === 0;

  // Fold the (key, endpoint, day) buckets down to one series per day for the sparkline.
  const byDay = new Map<string, number>();
  for (const bucket of usage?.days ?? []) {
    byDay.set(bucket.day, (byDay.get(bucket.day) ?? 0) + bucket.calls);
  }
  const points = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, calls]) => ({ day, calls }));

  const matchRate =
    totals && totals.calls > 0 ? Math.round((totals.billedCalls / totals.calls) * 100) : null;

  return (
    <WidgetCard
      title="API usage"
      icon={Plug}
      hint="Last 30 days"
      loading={loading}
      error={error}
      empty={empty}
      onRetry={reload}
      emptyIcon={Plug}
      emptyTitle={unavailable ? "API not enabled" : "No API calls yet"}
      emptyDescription={
        unavailable
          ? "The data API is not switched on for this deployment yet."
          : "Create a key in Settings ▸ Developer, then calls made with it show up here."
      }
    >
      <div className={styles.apiSparkWrap}>
        <UsageSparkline points={points} />
      </div>
      <div className={styles.apiFigures}>
        <div className={styles.apiFigure}>
          <span className={styles.apiFigureValue}>{(totals?.calls ?? 0).toLocaleString()}</span>
          <span className={styles.apiFigureLabel}>Calls</span>
        </div>
        <div className={styles.apiFigure}>
          <span className={styles.apiFigureValue}>
            {(totals?.billedCalls ?? 0).toLocaleString()}
          </span>
          <span className={styles.apiFigureLabel}>Billed</span>
        </div>
        <div className={styles.apiFigure}>
          <span className={styles.apiFigureValue}>
            {(totals?.creditsSpent ?? 0).toLocaleString()}
          </span>
          <span className={styles.apiFigureLabel}>Credits</span>
        </div>
      </div>
      {matchRate !== null ? (
        <p className={styles.apiNote}>
          {matchRate}% of calls returned data. The rest cost nothing.
        </p>
      ) : null}
    </WidgetCard>
  );
}
