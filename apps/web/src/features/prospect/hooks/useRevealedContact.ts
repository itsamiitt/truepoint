// useRevealedContact.ts — loads a contact's ALREADY-OWNED reveal data (no charge) for the record detail, so an
// already-revealed contact shows its email/phone instantly and persistently (no "View revealed" re-confirm,
// no re-charge — Phase 1). Gated on `enabled` (the contact's coarse isRevealed flag) so an unrevealed contact
// never hits the endpoint. `setData` lets a fresh in-drawer reveal seed the view without a refetch; `reload`
// re-pulls after a new reveal so a newly-uncovered field (e.g. phone after email) appears.
"use client";

import type { RevealedContact } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchRevealedContact } from "../api";

export interface UseRevealedContact {
  data: RevealedContact | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setData: (next: RevealedContact | null) => void;
}

export function useRevealedContact(contactId: string | null, enabled: boolean): UseRevealedContact {
  const [data, setData] = useState<RevealedContact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!contactId || !enabled) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await fetchRevealedContact(contactId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load revealed data");
    } finally {
      setLoading(false);
    }
  }, [contactId, enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, reload: load, setData };
}
