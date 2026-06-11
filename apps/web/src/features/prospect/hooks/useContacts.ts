// useContacts.ts — loads the workspace's masked contacts for the prospect grid, with a `reload`. The search
// endpoint is list-only at MVP (05 §5), so the rail filters these loaded rows client-side. Presentation
// state only; masking happens server-side.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchContacts } from "../api";

export function useContacts(limit = 100) {
  const [contacts, setContacts] = useState<MaskedContact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setContacts(await fetchContacts(limit));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load contacts");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Patch one row in place after a reveal flips isRevealed — avoids a full refetch of the grid. */
  const markRevealed = useCallback((id: string) => {
    setContacts((rows) => rows.map((c) => (c.id === id ? { ...c, isRevealed: true } : c)));
  }, []);

  return { contacts, error, loading, reload, markRevealed };
}
