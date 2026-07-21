// useImportDrafts.ts — the viewer's live import DRAFTS (S-U7; 08 §7's `?state=draft` wizard-resume opt-in).
// One TanStack entry (importKeys.drafts) serves both consumers: the wizard's draft-path gate probe (data
// arrived ⇒ the IMPORT_V2 dual gate is on) and the history page's "Continue setup" banner. A gate-off 404
// (ImportsNotEnabledError) is a terminal answer — never retried, surfaced as `notEnabled`, and the banner
// simply renders nothing (the honest dark posture, mirroring useImportJobs).
"use client";

import { useQuery } from "@tanstack/react-query";
import type { ImportJobListItem } from "@leadwolf/types";
import { fetchImportDrafts } from "../apiDrafts";
import { importKeys } from "../keys";

export function useImportDrafts(opts?: { enabled?: boolean }) {
  const query = useQuery({
    queryKey: importKeys.drafts(),
    queryFn: () => fetchImportDrafts(),
    enabled: opts?.enabled ?? true,
    staleTime: 30_000,
    retry: (count, err) => {
      if ((err as { notEnabled?: boolean })?.notEnabled) return false; // gate-off: don't hammer the 404
      return count < 2;
    },
  });

  const drafts: ImportJobListItem[] = query.data?.jobs ?? [];
  const notEnabled = query.isError && Boolean((query.error as { notEnabled?: boolean })?.notEnabled);
  return { ...query, drafts, notEnabled };
}
