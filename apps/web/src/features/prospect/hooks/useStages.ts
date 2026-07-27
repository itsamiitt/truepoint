// useStages.ts — the workspace's pipeline stages for the management panel + the record StageSelector
// (G-REV-7, ADR-0028). The stage list (and the maps_to_status rollup) is authoritative server-side; this hook
// only fetches and exposes view state.
//
// `available: false` is how the API reports "this is not built for you" — carried in the query data, not as
// an error, so it does not sit behind retry/error handling.
"use client";

import { useQuery } from "@tanstack/react-query";
import { prospectKeys } from "../keys";
import { fetchStages } from "../stagesApi";

export function useStages(includeArchived = false) {
  const query = useQuery({
    queryKey: prospectKeys.stages(includeArchived),
    queryFn: () => fetchStages(includeArchived),
  });

  return {
    stages: query.data?.stages ?? null,
    available: query.data?.available ?? true,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load stages"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
