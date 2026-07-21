// useImportJob.ts — one durable import job's detail, polled indefinitely per the 09 §4.3 cadence (2.5 s while
// active, 10 s while queued/deferred, STOP on terminal) — there is no give-up (11 §4.1; the ~2-min poller is
// deleted with useImport). The handle is the URL, so refresh/return resumes cleanly. Reads the v2 `statusV2`
// when the dual gate is on, falling back to the legacy poll `status` for gate-off / legacy numeric ids.
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchImportJobDetail } from "../apiV2";
import { isTerminalV2, legacyStatusToV2 } from "../components/shared/stateCopy";
import { importKeys } from "../keys";

export function useImportJob(jobId: string | null) {
  return useQuery({
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
}
