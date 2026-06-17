// useProfile.ts — loads the editable user profile (GET /settings/user/profile) with loading/error state and a
// `reload`. Presentation state only; the typed fetch lives in api.ts. One hook per resource (slice pattern).
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchProfile } from "../api";
import type { UserProfile } from "../types";

export function useProfile() {
  const [data, setData] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchProfile());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your profile");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}
