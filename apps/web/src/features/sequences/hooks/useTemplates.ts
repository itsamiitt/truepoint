// useTemplates.ts — loads the message-template library for the Templates panel (M9; 11 §4.3). Returns the
// standard { data, loading, error, reload } shape plus `available`: when the backend isn't wired yet the API
// helper resolves to available=false (not an error), so the panel renders a "connect …" empty state. Reads
// only — template authoring is post-MVP. Presentation state only.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchTemplates } from "../api";
import type { TemplateSummary } from "../types";

export function useTemplates() {
  const [data, setData] = useState<TemplateSummary[]>([]);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { items, available: ok } = await fetchTemplates();
      setData(items);
      setAvailable(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, available, error, loading, reload };
}
