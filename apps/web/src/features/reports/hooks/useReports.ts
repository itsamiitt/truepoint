// useReports.ts — loads the report's raw inputs (balance + usage + contacts, in parallel), applies the
// date-range + member filters, then derives the four computable dashboard view models via the pure rollups.
// Presentation state only; one loading/error pair + reload. The deliverability + lead-score dashboards have no
// backend yet (ClickHouse /reports/* is post-MVP, ADR-0010) so they render a first-class empty state.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { type ReportsSource, fetchReportsSource } from "../api";
import { rollupCreditUsage, rollupDataHealth, rollupFunnel, rollupTeam } from "../rollups";

/** Date-range presets for the filter row (trailing windows over the loaded sample). */
export type RangeId = "7d" | "14d" | "30d" | "all";

export const RANGE_OPTIONS: { value: RangeId; label: string; days: number | null }[] = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "14d", label: "Last 14 days", days: 14 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "all", label: "All time", days: null },
];

const DAY_MS = 86_400_000;

export function useReports() {
  const [source, setSource] = useState<ReportsSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [range, setRange] = useState<RangeId>("14d");
  const [member, setMember] = useState<string>("all");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSource(await fetchReportsSource());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The member options come from the loaded data (owner ids on contacts + reveals); labels mirror rollups.
  const memberOptions = useMemo(() => {
    if (!source) return [];
    const ids = new Set<string>();
    for (const c of source.contacts) if (c.ownerUserId) ids.add(c.ownerUserId);
    for (const r of source.reveals) if (r.revealedByUserId) ids.add(r.revealedByUserId);
    return [...ids].map((id) => ({
      value: id,
      label: `Member ${id.replace(/-/g, "").slice(-4).toUpperCase() || id.slice(0, 4).toUpperCase()}`,
    }));
  }, [source]);

  // Apply the date-range + member filters to the raw rows before rolling up. The range is a trailing window
  // over the loaded sample (contacts by createdAt, reveals by revealedAt) — a stand-in until /reports/* lands.
  const filtered = useMemo(() => {
    if (!source) return null;
    const days = RANGE_OPTIONS.find((o) => o.value === range)?.days ?? null;
    const cutoff = days != null ? Date.now() - days * DAY_MS : null;

    const inRange = (iso: string): boolean => {
      if (cutoff == null) return true;
      const t = new Date(iso).getTime();
      return Number.isNaN(t) ? true : t >= cutoff;
    };

    const contacts = source.contacts.filter(
      (c) => inRange(c.createdAt) && (member === "all" || c.ownerUserId === member),
    );
    const reveals = source.reveals.filter(
      (r) => inRange(r.revealedAt) && (member === "all" || r.revealedByUserId === member),
    );
    return { contacts, reveals };
  }, [source, range, member]);

  const credit = useMemo(() => (filtered ? rollupCreditUsage(filtered.reveals) : null), [filtered]);
  const funnel = useMemo(() => (filtered ? rollupFunnel(filtered.contacts) : null), [filtered]);
  const health = useMemo(() => (filtered ? rollupDataHealth(filtered.contacts) : null), [filtered]);
  const team = useMemo(
    () => (filtered ? rollupTeam(filtered.contacts, filtered.reveals) : null),
    [filtered],
  );

  return {
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
