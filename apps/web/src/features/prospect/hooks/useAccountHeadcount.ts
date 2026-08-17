// useAccountHeadcount.ts — an account's monthly headcount totals series (0114). Growth deltas are DERIVED
// here from the series (the no-rollup rule: the server ships points, the client does arithmetic).
"use client";

import type { AccountHeadcountResponse } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { fetchAccountHeadcount } from "../accountIntelligenceApi";
import { prospectKeys } from "../keys";

export interface HeadcountDeltas {
  latest: number | null;
  oneMonthPct: number | null;
  oneYearPct: number | null;
}

/** newest-first series → {latest, 1m%, 1y%}; null when the window's baseline point is absent or zero. */
export function headcountDeltas(
  series: ReadonlyArray<{ month: string; employee_count: number }>,
): HeadcountDeltas {
  const latest = series[0]?.employee_count ?? null;
  const pct = (baseline: number | undefined): number | null =>
    latest !== null && baseline !== undefined && baseline > 0
      ? ((latest - baseline) / baseline) * 100
      : null;
  return {
    latest,
    oneMonthPct: pct(series[1]?.employee_count),
    oneYearPct: pct(series[12]?.employee_count),
  };
}

export function useAccountHeadcount(accountId: string | null) {
  const query = useQuery<AccountHeadcountResponse>({
    queryKey: prospectKeys.accountHeadcount(accountId ?? ""),
    enabled: accountId !== null,
    queryFn: () => fetchAccountHeadcount(accountId as string),
  });

  const series = query.data?.series ?? [];
  return {
    series,
    deltas: headcountDeltas(series),
    resolved: query.data?.resolved ?? false,
    loading: query.isPending && accountId !== null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load headcount"
      : null,
    reload: () => void query.refetch(),
  };
}
