// useMailboxes.ts — presentation state for the connected-mailboxes list (M12, email-planning/13 P0). Vanilla
// React (useState/useCallback), one fetch per mount + a manual reload after the connect mutation, the
// {available} envelope for the not-yet-wired case. NOT TanStack Query (14 §3).
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchMailboxes } from "../api";
import type { MailboxView } from "../types";

export function useMailboxes() {
  const [mailboxes, setMailboxes] = useState<MailboxView[]>([]);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchMailboxes();
      setMailboxes(res.items);
      setAvailable(res.available);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load mailboxes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { mailboxes, available, error, loading, reload };
}
