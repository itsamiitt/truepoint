// useContacts.ts — the workspace's masked contacts for the post-import view, with a `reload` the wizard calls
// after a successful import. Presentation state only; the masking happens server-side.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { fetchContacts } from "../api";
import { importKeys } from "../keys";

export function useContacts() {
  const query = useQuery<MaskedContact[]>({
    queryKey: importKeys.contacts(),
    queryFn: fetchContacts,
  });

  return {
    contacts: query.data ?? [],
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load contacts"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
  };
}
