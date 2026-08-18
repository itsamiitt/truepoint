"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchExtensionMeta } from "../api";
import type { ExtensionMeta } from "../types";

/** Loads the packaged-extension metadata; presentation state only (data/loading/error/reload). */
export function useExtensionMeta() {
  const [meta, setMeta] = useState<ExtensionMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchExtensionMeta()
      .then(setMeta)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { meta, loading, error, reload };
}
