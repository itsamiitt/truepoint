// useImportJob.ts — one durable import job's detail, polled on the 09 §4.3 cadence (2.5 s while active, 10 s
// while queued/deferred, STOP on terminal), with a BOUNDED horizon (perf-audit P0.10, amending 11 §4.1's
// "no give-up"): a job that never reaches a terminal status — a stuck worker, a failed deploy, a detail
// endpoint that errors — used to poll a left-open tab at 2.5 s FOREVER (~1,440 req/h). Now the cadence eases
// to 30 s after 5 minutes and stops after 15; the handle is the URL, so refresh/return restarts the poll
// cleanly, which preserves 11 §4.1's actual intent (resume on return) without the unbounded tail. Reads the
// v2 `statusV2` when the dual gate is on, falling back to the legacy poll `status` for legacy numeric ids.
"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { fetchImportJobDetail } from "../apiV2";
import { isTerminalV2, legacyStatusToV2 } from "../components/shared/stateCopy";
import { importKeys } from "../keys";

/** After this long without a terminal status, ease the cadence to the slow interval. */
const POLL_SLOW_AFTER_MS = 5 * 60_000;
/** After this long, stop polling entirely — a manual refresh / reopen restarts the clock. */
const POLL_GIVE_UP_MS = 15 * 60_000;
const POLL_SLOW_MS = 30_000;

export function useImportJob(jobId: string | null) {
  const queryClient = useQueryClient();
  const invalidatedFor = useRef<string | null>(null);

  // Poll horizon per job id: reset when the watched job changes, so switching jobs restarts the clock.
  const startedAt = useRef<{ jobId: string | null; at: number }>({ jobId, at: Date.now() });
  if (startedAt.current.jobId !== jobId) startedAt.current = { jobId, at: Date.now() };

  const query = useQuery({
    queryKey: importKeys.detail(jobId ?? "none"),
    queryFn: () => fetchImportJobDetail(jobId as string),
    enabled: jobId != null,
    refetchInterval: (query) => {
      const data = query.state.data;
      const status = data ? (data.statusV2 ?? legacyStatusToV2(data.status)) : null;
      if (status && isTerminalV2(status)) return false;
      const elapsed = Date.now() - startedAt.current.at;
      if (elapsed >= POLL_GIVE_UP_MS) return false;
      if (elapsed >= POLL_SLOW_AFTER_MS) return POLL_SLOW_MS;
      // A detail read that errors (no data) gets the queued cadence, not the hot one — a 404/500 at 2.5 s
      // forever was the pathological case this horizon exists for.
      if (!data) return 10_000;
      return status === "queued" || status === "deferred" ? 10_000 : 2_500;
    },
  });

  // Cross-feature cache sync (extension-intelligence-loop slice D): the import lands contacts on a WORKER,
  // so no mutation hook ever sees the write — this poll is the only place the client learns it finished.
  // On the transition to terminal, invalidate every surface that lists contacts (the Prospect grid's search
  // entries + the post-import table), once per job, so freshly imported rows appear without a manual refresh.
  const data = query.data;
  useEffect(() => {
    if (!jobId || !data) return;
    const status = data.statusV2 ?? legacyStatusToV2(data.status);
    if (!isTerminalV2(status) || invalidatedFor.current === jobId) return;
    invalidatedFor.current = jobId;
    // Literal root key mirroring prospectKeys.all — a keys import would be a cross-feature dependency
    // (import → prospect) the boundary rules forbid; the key ARRAY is the stable public contract here.
    void queryClient.invalidateQueries({ queryKey: ["prospect"] });
    void queryClient.invalidateQueries({ queryKey: importKeys.contacts() });
    void queryClient.invalidateQueries({ queryKey: importKeys.list() });
  }, [jobId, data, queryClient]);

  return query;
}
