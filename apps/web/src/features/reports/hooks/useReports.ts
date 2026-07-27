// useReports.ts — loads the report's raw inputs (balance + usage + contacts, in parallel), applies the
// date-range + member filters, then derives the four computable dashboard view models via the pure rollups.
// Presentation state only; one loading/error pair + reload. The deliverability + lead-score dashboards have no
// backend yet (ClickHouse /reports/* is post-MVP, ADR-0010) so they render a first-class empty state.
//
// The FETCH is a query; the rollups stay client-side. That split is deliberate and temporary: C-3.10 is the
// item that moves the aggregation server-side, and it is open on two product decisions (whether day buckets
// are viewer-local or UTC, and where the member dropdown's options come from) — not on the data layer. So
// this caches and dedupes the load without pretending the numbers past the loaded sample are right.
"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { type ReportsSource, fetchReportsSource, fetchReportsSummary } from "../api";
import { reportKeys } from "../keys";
import {
  creditUsageFromBuckets,
  dataHealthFromCounts,
  funnelFromCounts,
  teamFromCounts,
} from "../rollups";

/** Date-range presets for the filter row (trailing windows over the loaded sample). */
export type RangeId = "7d" | "14d" | "30d" | "all";

export const RANGE_OPTIONS: { value: RangeId; label: string; days: number | null }[] = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "14d", label: "Last 14 days", days: 14 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "all", label: "All time", days: null },
];

export function useReports() {
  // The balance tile still comes from the raw source; everything else is now counted server-side.
  const query = useQuery<ReportsSource>({
    queryKey: reportKeys.source(),
    queryFn: fetchReportsSource,
  });
  const source = query.data ?? null;
  // The range and member filters are CLIENT state — what the user picked. They are sent to the SERVER now
  // rather than applied to loaded rows, so they form part of the query key below.
  const [range, setRange] = useState<RangeId>("14d");
  const [member, setMember] = useState<string>("all");

  // The SERVER-aggregated counts, keyed by the filters — they are server inputs now, not client-side row
  // predicates, so a filter change is a new query rather than a re-filter of a 200-row sample.
  const summaryQuery = useQuery({
    queryKey: reportKeys.summary(range, member),
    queryFn: () => fetchReportsSummary(range, member),
  });
  const summary = summaryQuery.data ?? null;

  // Either query failing is a page-level failure: the dashboards are meaningless without the counts, and the
  // balance tile without them is a number floating on an empty page.
  const failure = summaryQuery.error ?? query.error;
  const error = failure
    ? failure instanceof Error
      ? failure.message
      : "Failed to load reports"
    : null;
  const loading = query.isPending || summaryQuery.isPending;
  const reload = () => {
    void query.refetch();
    void summaryQuery.refetch();
  };

  // From the whole workspace, not from whichever rows happened to load. The label is still synthesised from
  // the id — the server deliberately returns ids only rather than making a report a new place names appear.
  const memberOptions = useMemo(
    () =>
      (summary?.memberOptions ?? []).map((id) => ({
        value: id,
        label: `Member ${id.replace(/-/g, "").slice(-4).toUpperCase() || id.slice(0, 4).toUpperCase()}`,
      })),
    [summary],
  );

  const credit = useMemo(
    () => (summary ? creditUsageFromBuckets(summary.creditsByDay, summary.creditsByType) : null),
    [summary],
  );
  const funnel = useMemo(
    () =>
      summary
        ? funnelFromCounts(
            new Map(summary.funnel.map((f) => [f.status, f.count])),
            summary.contactTotal,
          )
        : null,
    [summary],
  );
  const health = useMemo(
    () =>
      summary
        ? dataHealthFromCounts(
            new Map(summary.health.map((h) => [h.status, h.count])),
            summary.contactTotal,
            summary.withEmail,
          )
        : null,
    [summary],
  );
  const team = useMemo(() => (summary ? teamFromCounts(summary.team) : null), [summary]);

  return {
    // The rollups are counted server-side over the WHOLE workspace now, so there is no sample to disclose.
    // Kept in the shape so the page does not have to change again if a future surface reintroduces one.
    sampled: false,
    balance: source?.balance ?? null,
    credit,
    funnel,
    health,
    team,
    memberOptions,
    range,
    setRange,
    member,
    setMember,
    error,
    loading,
    reload,
  };
}
