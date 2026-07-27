// useRevealedContact.ts — a contact's ALREADY-OWNED reveal data (no charge) for the record detail, so an
// already-revealed contact shows its email/phone instantly and persistently (no "View revealed" re-confirm, no
// re-charge — Phase 1). Gated on `enabled` (the contact's coarse isRevealed flag) so an unrevealed contact
// never hits the endpoint. `setData` lets a fresh in-drawer reveal seed the view without a refetch; `reload`
// re-pulls after a new reveal so a newly-uncovered field (e.g. phone after email) appears.
//
// `setData` writes into the CACHE rather than component state, which is what makes the seeding survive the
// drawer closing and reopening — previously a reveal seeded a value that was thrown away on unmount and
// re-fetched on the next open.
"use client";

import type { RevealedContact } from "@leadwolf/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { fetchRevealedContact } from "../api";
import { prospectKeys } from "../keys";

export interface UseRevealedContact {
  data: RevealedContact | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setData: (next: RevealedContact | null) => void;
}

export function useRevealedContact(contactId: string | null, enabled: boolean): UseRevealedContact {
  const qc = useQueryClient();
  const key = prospectKeys.revealedContact(contactId ?? "");
  const active = contactId !== null && enabled;

  const query = useQuery<RevealedContact>({
    queryKey: key,
    enabled: active,
    queryFn: () => fetchRevealedContact(contactId as string),
  });

  const setData = useCallback(
    (next: RevealedContact | null) => {
      if (!contactId) return;
      if (next) qc.setQueryData(key, next);
      else qc.removeQueries({ queryKey: key });
    },
    [qc, key, contactId],
  );

  return {
    data: active ? (query.data ?? null) : null,
    loading: query.isPending && active,
    error:
      active && query.error
        ? query.error instanceof Error
          ? query.error.message
          : "Could not load revealed data"
        : null,
    reload: async () => {
      await query.refetch();
    },
    setData,
  };
}
