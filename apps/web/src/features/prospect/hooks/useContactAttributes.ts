// useContactAttributes.ts — a contact's skills + languages from the graph (0116;
// linkedin-source-ingestion §read surfaces). The useContactEmployment shape, verbatim.
"use client";

import type { ContactAttributesResponse } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { fetchContactAttributes } from "../accountIntelligenceApi";
import { prospectKeys } from "../keys";

export function useContactAttributes(contactId: string | null) {
  const query = useQuery<ContactAttributesResponse>({
    queryKey: prospectKeys.contactAttributes(contactId ?? ""),
    enabled: contactId !== null,
    queryFn: () => fetchContactAttributes(contactId as string),
  });

  return {
    skills: query.data?.skills ?? [],
    languages: query.data?.languages ?? [],
    resolved: query.data?.resolved ?? false,
    loading: query.isPending && contactId !== null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load attributes"
      : null,
    reload: () => void query.refetch(),
  };
}
