// useMailboxes.ts — the connected-mailboxes list (M12, email-planning/13 P0). The {available} envelope covers
// the not-yet-wired case and is carried in the query DATA, not as an error — "not built for you" is a valid
// answer from a working endpoint.
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchMailboxes } from "../api";
import { settingsMailboxKeys } from "../keys";

export function useMailboxes() {
  const query = useQuery({
    queryKey: settingsMailboxKeys.mailboxes(),
    queryFn: fetchMailboxes,
  });

  return {
    mailboxes: query.data?.items ?? [],
    available: query.data?.available ?? true,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load mailboxes"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
