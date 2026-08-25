// AccountGraphSections.tsx — the two Layer-0 account surfaces that are conditional rather than always-on
// (plan 33 · Track C): displacement, and alumni for institutions that are actually schools.
//
// Both live here rather than in AccountTechnologySections because they share a rule that the always-on
// sections do not: THEY HIDE THEMSELVES WHEN THEY HAVE NOTHING TO SAY. "Runs" renders an honest empty state
// because a company always has *some* stack and its absence is informative. Displacement is different — the
// overwhelmingly common truthful answer is "nothing dropped recently", and a permanent empty panel on every
// account is noise that trains people to skip the region. Same for alumni on a company: the question does
// not apply, so the answer is not "none", it is silence.
"use client";

import type { AccountAlumniResponse, AccountDisplacementResponse } from "@leadwolf/types";
import { ErrorState, StatusBadge, TpChip } from "@leadwolf/ui";
import { useQuery } from "@tanstack/react-query";
import { fetchAccountAlumni, fetchAccountDisplacement } from "../accountIntelligenceApi";
import { prospectKeys } from "../keys";
import styles from "../prospect.module.css";

/**
 * Self-hiding sections still have to distinguish "nothing to say" from "we could not ask".
 *
 * Reading only `query.data` collapses three different situations into one blank region: the feature is dark,
 * the answer is genuinely empty, and the request failed. The first two are the silence this file is built
 * around; the third is a 500 that the user is never told about and can never retry. So the error branch runs
 * FIRST, keeps the heading so it is clear WHAT failed, and offers the retry — and only then does the
 * dark/empty check return null exactly as before.
 */
const INLINE_ERROR_STYLE = {
  padding: "var(--tp-space-4) 0",
  alignItems: "flex-start",
  textAlign: "left",
} as const;

function monthsAgo(iso: Date | string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 30) return `${Math.max(days, 1)}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * What they recently stopped running.
 *
 * Renders nothing at all unless there is something to report — see the file header for why this differs from
 * the always-on sections.
 */
export function AccountDisplacementSection({ accountId }: { accountId: string | null }) {
  const query = useQuery<AccountDisplacementResponse>({
    queryKey: prospectKeys.accountDisplacement(accountId ?? ""),
    enabled: accountId !== null,
    queryFn: () => fetchAccountDisplacement(accountId as string),
  });

  if (query.error) {
    return (
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>Recently dropped</h3>
        </div>
        <ErrorState
          title="Couldn't load recently dropped technology"
          detail={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => void query.refetch()}
          style={INLINE_ERROR_STYLE}
        />
      </section>
    );
  }

  const data = query.data;
  const removed = data?.removed ?? [];
  if (!data || !data.resolved || removed.length === 0) return null;

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>Recently dropped</h3>
        <StatusBadge tone="warning">{removed.length}</StatusBadge>
      </div>
      <p className={styles.fieldLabel}>
        Detected in their stack before, and no longer. A migration window.
      </p>
      <div className={styles.chipWrap}>
        {removed.map((row) => (
          <TpChip key={row.technology_id}>
            {row.canonical_name}
            <span className={styles.fieldLabel}> · dropped {monthsAgo(row.removed_at)}</span>
          </TpChip>
        ))}
      </div>
    </section>
  );
}

/**
 * Which of the caller's OWN contacts studied here.
 *
 * Hidden unless the bridged institution is genuinely a school AND we hold matching contacts — on a company
 * the question does not apply, and "0 alumni" would be a nonsense answer rather than an empty one.
 */
export function AccountAlumniSection({ accountId }: { accountId: string | null }) {
  const query = useQuery<AccountAlumniResponse>({
    queryKey: prospectKeys.accountAlumni(accountId ?? ""),
    enabled: accountId !== null,
    queryFn: () => fetchAccountAlumni(accountId as string),
  });

  if (query.error) {
    return (
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>Your alumni here</h3>
        </div>
        <ErrorState
          title="Couldn't load alumni"
          detail={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => void query.refetch()}
          style={INLINE_ERROR_STYLE}
        />
      </section>
    );
  }

  const data = query.data;
  const alumni = data?.alumni ?? [];
  // Unchanged self-hide: not resolved (dark), not a school, or no matching contacts → silence, not "0 alumni".
  if (!data || !data.resolved || !data.is_school || alumni.length === 0) return null;

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>Your alumni here</h3>
        <StatusBadge tone="muted">{alumni.length}</StatusBadge>
      </div>
      <p className={styles.fieldLabel}>
        Contacts in your workspace who studied at this institution.
      </p>
      <ul className={styles.timeline}>
        {alumni.map((a) => (
          <li key={a.contact_id} className={styles.timelineItem}>
            <div className={styles.timelineMeta}>
              <div className={styles.fieldValue}>
                {[a.first_name, a.last_name].filter(Boolean).join(" ") || "Unnamed contact"}
              </div>
              <div className={styles.fieldLabel}>
                {[a.job_title, a.degree, a.ended_on ? `class of ${a.ended_on.slice(0, 4)}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
