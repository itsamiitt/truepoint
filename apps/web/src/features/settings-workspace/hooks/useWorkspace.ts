// useWorkspace.ts — loads the workspace general settings (GET /workspaces/current) with loading/error + reload,
// and exposes save(). Presentation state only; typed fetches live in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWorkspace, saveWorkspace } from "../api";
import type { WorkspaceGeneral } from "../types";

export function useWorkspace() {
  const [data, setData] = useState<WorkspaceGeneral | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ws = await fetchWorkspace();
      setData(ws);
      setAvailable(ws != null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load workspace settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(async (patch: Partial<WorkspaceGeneral>): Promise<boolean> => {
    const { ok } = await saveWorkspace(patch);
    return ok;
  }, []);

  return { data, available, error, loading, reload, save };
}
