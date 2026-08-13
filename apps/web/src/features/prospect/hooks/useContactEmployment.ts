// useContactEmployment.ts — a contact's career history from the graph (plan 33 · A2).
"use client";

import type { ContactEmploymentResponse } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { fetchContactEmployment } from "../accountIntelligenceApi";
import { prospectKeys } from "../keys";

export function useContactEmployment(contactId: string | null) {
  const query = useQuery<ContactEmploymentResponse>({
    queryKey: prospectKeys.contactEmployment(contactId ?? ""),
    enabled: contactId !== null,
    queryFn: () => fetchContactEmployment(contactId as string),
  });

  return {
    stints: query.data?.employment ?? [],
    resolved: query.data?.resolved ?? false,
    loading: query.isPending && contactId !== null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load employment"
      : null,
    reload: () => void query.refetch(),
  };
}
