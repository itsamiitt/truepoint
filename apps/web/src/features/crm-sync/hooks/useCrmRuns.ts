// useCrmRuns.ts — recent sync activity for one connection (GET /crm/connections/:id/runs).
//
// Polls while the panel is open: a sync run is short-lived server-side work with no push channel, so a
// stale list is the difference between "it is working" and "nothing happened". `enabled` is false without a
// connection id, so selecting nothing issues no request rather than a request for `undefined`.
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchCrmRuns } from "../api";
import { crmSyncKeys } from "../keys";
import type { CrmSyncRunView } from "../types";

export function useCrmRuns(connectionId: string | null) {
  const query = useQuery<CrmSyncRunView[]>({
    queryKey: crmSyncKeys.runs(connectionId ?? ""),
    queryFn: () => fetchCrmRuns(connectionId as string),
    enabled: Boolean(connectionId),
    // Status-conditional (perf-checklist PA-8, the useEnrichmentJobs template): 30s only while a run is
    // actually `running`; 120s otherwise — the idle feed changes only when a schedule or a Sync-now fires
    // (and Sync-now invalidates this key anyway), so the old unconditional 30s polled a terminal list
    // forever once a connection was selected.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((run) => run.status === "running") ? 30_000 : 120_000,
  });

  return {
    runs: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load recent sync activity"
      : null,
    loading: query.isPending && Boolean(connectionId),
    reload: () => {
      void query.refetch();
    },
  };
}
