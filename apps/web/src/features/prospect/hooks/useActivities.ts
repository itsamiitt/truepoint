// useActivities.ts — one contact's activity timeline for the record-detail Drawer.
// The timeline backend is an M8 gate, so api.fetchActivities maps a 404/501 to available:false and this hook
// surfaces that as an empty (not error) state. Presentation state only.
"use client";

import { useQuery } from "@tanstack/react-query";
import { type ActivityFeed, fetchActivities } from "../api";
import { prospectKeys } from "../keys";

export function useActivities(contactId: string | null) {
  const query = useQuery<ActivityFeed>({
    queryKey: prospectKeys.activities(contactId ?? ""),
    // No contact selected is not a load — the drawer is closed. `enabled` keeps it out of the cache rather
    // than storing an entry under an empty id.
    enabled: contactId !== null,
    queryFn: () => fetchActivities(contactId as string),
  });

  return {
    feed: contactId ? (query.data ?? null) : null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load activity"
      : null,
    loading: query.isPending && contactId !== null,
    reload: () => {
      void query.refetch();
    },
  };
}
