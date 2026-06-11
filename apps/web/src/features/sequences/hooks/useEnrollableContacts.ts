// useEnrollableContacts.ts — loads the workspace's masked contacts and narrows to revealed rows, the only
// ones the outreach API accepts for enrollment (unrevealed → 422 validation_error). Presentation state only.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { useEffect, useMemo, useState } from "react";
import { fetchContacts } from "../api";

export function useEnrollableContacts() {
  const [contacts, setContacts] = useState<MaskedContact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchContacts();
        if (!cancelled) setContacts(rows);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load contacts");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enrollable = useMemo(() => contacts.filter((c) => c.isRevealed), [contacts]);

  return { enrollable, error, loading };
}
