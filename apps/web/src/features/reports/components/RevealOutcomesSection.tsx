// RevealOutcomesSection.tsx — reveal hit rate + latency, read off usage_event.
//
// This is the number 06-roadmap Phase 1 states its KILL criterion against ("reveal-hit rate <40% in the
// beachhead after seed load → stop"). Until this panel it had no reader anywhere: outcomeMetricsRepository
// was exported from the db barrel and called by nothing, so the metric the roadmap says decides whether to
// continue could not be looked at.
//
// It cannot be taken from the credit meters: contact_reveals records what was CHARGED, and a miss never
// creates a claim row, so any hit rate derived from it is 100% by construction.
//
// Presentation only, and reusing the existing rate/figure classes rather than introducing colour of its own —
// every foreground/background pair on this page is enumerated in apps/web/src/contrast.test.ts, so a new one
// is a new AA obligation and this panel does not need one to say what it means.
"use client";

import type { RevealOutcomes } from "@leadwolf/types";
import { EmptyState, Icon, Progress, StateSwitch } from "@leadwolf/ui";
import { Target } from "lucide-react";
import styles from "../reports.module.css";

/** The roadmap's Phase 1 threshold. Named rather than inlined so the panel and the doc cannot drift apart. */
const KILL_THRESHOLD = 0.4;

function formatRate(rate: number | null): string {
  // "Not enough data" is NOT 0%. They are opposite conclusions — one says nobody has tried, the other says
  // every attempt failed — and the whole reason the API keeps this nullable is so a kill criterion is never
  // read off an empty workspace.
  if (rate === null) return "Not enough data";
  return `${Math.round(rate * 100)}%`;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "Not enough data";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function RevealOutcomesSection({
  outcomes,
  loading,
  error,
  onRetry,
}: {
  outcomes: RevealOutcomes | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const attempts = outcomes ? outcomes.hits + outcomes.misses : 0;

  return (
    <StateSwitch
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && attempts === 0}
      emptyState={
        <EmptyState
          icon={<Icon icon={Target} size={28} />}
          title="No reveals yet"
          description="Hit rate and latency appear once contacts have been revealed in this workspace."
        />
      }
    >
      {outcomes ? (
        <>
          <div className={styles.rates}>
            <div className={styles.rate}>
              <div className={styles.rateHead}>
                <span className={styles.rateLabel}>Reveal hit rate</span>
                <span className={styles.rateValue}>{formatRate(outcomes.hitRate)}</span>
              </div>
              {/* max is the attempt count, so the bar is hits-of-attempts rather than a percentage
                  re-derived from the rounded label. */}
              <Progress
                value={outcomes.hits}
                max={attempts || 1}
                tone={
                  outcomes.hitRate !== null && outcomes.hitRate < KILL_THRESHOLD
                    ? "warning"
                    : "success"
                }
                label="Reveal hit rate"
              />
              <span className={styles.rateSub}>
                {outcomes.hits.toLocaleString()} of {attempts.toLocaleString()} lookup
                {attempts === 1 ? "" : "s"} returned data
              </span>
            </div>
          </div>

          <dl className={styles.figureList}>
            <div className={styles.figureRow}>
              <dt className={styles.figureLabel}>Lookups that found nothing</dt>
              <dd className={styles.figureValue}>{outcomes.misses.toLocaleString()}</dd>
            </div>
            <div className={styles.figureRow}>
              <dt className={styles.figureLabel}>Reveal latency (p95, server)</dt>
              <dd className={styles.figureValue}>{formatLatency(outcomes.p95ServerMs)}</dd>
            </div>
          </dl>

          <p className={styles.footnote}>
            Latency is measured server-side, so it is a lower bound on what someone waits — it
            excludes network time and rendering. A miss means the lookup ran and no field was found;
            it is counted here but never charged.
          </p>
        </>
      ) : null}
    </StateSwitch>
  );
}
