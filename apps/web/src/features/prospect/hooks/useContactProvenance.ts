// useContactProvenance.ts — the evidence behind a record's fields (plan 33 · A1).
//
// One request per RECORD, fetched when the drawer opens — never per grid row. The grid gets its band from
// the search payload instead, because a per-row fetch across a 50-row page is an N+1 the user would feel.
"use client";

import type { ContactProvenanceResponse, FieldProvenanceDto } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { fetchContactProvenance } from "../accountIntelligenceApi";
import { prospectKeys } from "../keys";

export function useContactProvenance(contactId: string | null) {
  const query = useQuery<ContactProvenanceResponse>({
    queryKey: prospectKeys.contactProvenance(contactId ?? ""),
    enabled: contactId !== null,
    queryFn: () => fetchContactProvenance(contactId as string),
  });

  const fields = query.data?.fields ?? [];
  return {
    fields,
    /** Look up one field's badge, or null when we hold no evidence for it. */
    forField: (field: string): FieldProvenanceDto | null =>
      fields.find((f) => f.field === field) ?? null,
    /** false = no Layer-0 person bridge, so there is no evidence LOG — not "no evidence exists". */
    resolved: query.data?.resolved ?? false,
    loading: query.isPending && contactId !== null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load provenance"
      : null,
    reload: () => void query.refetch(),
  };
}
