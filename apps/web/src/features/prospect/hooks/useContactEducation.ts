// useContactEducation.ts — a contact's education history for the record drawer (0108).
"use client";

import type { ContactEducationResponse } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { fetchContactEducation } from "../accountIntelligenceApi";
import { prospectKeys } from "../keys";

export function useContactEducation(contactId: string | null) {
  const query = useQuery<ContactEducationResponse>({
    queryKey: prospectKeys.contactEducation(contactId ?? ""),
    // No contact selected is not a load — the drawer is closed.
    enabled: contactId !== null,
    queryFn: () => fetchContactEducation(contactId as string),
  });

  return {
    education: query.data?.education ?? [],
    /** false = this contact has no Layer-0 person bridge yet, so we hold no education either way. */
    resolved: query.data?.resolved ?? false,
    loading: query.isPending && contactId !== null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load education"
      : null,
    reload: () => void query.refetch(),
  };
}
