// useImportJob.ts — one durable import job's detail, polled indefinitely per the 09 §4.3 cadence (2.5 s while
// active, 10 s while queued/deferred, STOP on terminal) — there is no give-up (11 §4.1; the ~2-min poller is
// deleted with useImport). The handle is the URL, so refresh/return resumes cleanly. Reads the v2 `statusV2`
// when the dual gate is on, falling back to the legacy poll `status` for gate-off / legacy numeric ids.
"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { fetchImportJobDetail } from "../apiV2";
import { isTerminalV2, legacyStatusToV2 } from "../components/shared/stateCopy";
import { importKeys } from "../keys";

export function useImportJob(jobId: string | null) {
  const queryClient = useQueryClient();
  const invalidatedFor = useRef<string | null>(null);

  const query = useQuery({
    queryKey: importKeys.detail(jobId ?? "none"),
    queryFn: () => fetchImportJobDetail(jobId as string),
    enabled: jobId != null,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2_500;
      const status = data.statusV2 ?? legacyStatusToV2(data.status);
      if (isTerminalV2(status)) return false;
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
