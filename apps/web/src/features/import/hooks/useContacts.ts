// useContacts.ts — loads the workspace's masked contacts for the post-import view, with a `reload` the
// wizard calls after a successful import. Presentation state only; the masking happens server-side.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchContacts } from "../api";

export function useContacts() {
  const [contacts, setContacts] = useState<MaskedContact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setContacts(await fetchContacts());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load contacts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { contacts, error, loading, reload };
}
