// useStages.ts — loads the workspace's pipeline stages for the management panel + the record StageSelector
// (G-REV-7, ADR-0028), with a `reload`. The stage list (and the maps_to_status rollup) is authoritative
// server-side; this hook only fetches + exposes view state. Presentation state only.
"use client";

import type { PipelineStage } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchStages } from "../stagesApi";

export function useStages(includeArchived = false) {
  const [stages, setStages] = useState<PipelineStage[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchStages(includeArchived);
      setStages(list.stages);
      setAvailable(list.available);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load stages");
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { stages, available, error, loading, reload };
}
