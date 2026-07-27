// useCustomFields.ts — one contact's custom-field feed plus the save path. Presentation state only; the
// definitions and validation are server-side.
"use client";

import type { CustomFieldValueInput } from "@leadwolf/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CustomFieldsFeed, fetchCustomFields, setCustomFields } from "../api";
import { prospectKeys } from "../keys";

export function useCustomFields(contactId: string | null) {
  const qc = useQueryClient();
  const query = useQuery<CustomFieldsFeed>({
    queryKey: prospectKeys.customFields(contactId ?? ""),
    // No contact selected is not a load — the drawer is closed. `enabled` keeps it out of the cache entirely
    // rather than storing an entry under an empty id.
    enabled: contactId !== null,
    queryFn: () => fetchCustomFields(contactId as string),
  });

  const save = useMutation({
    mutationFn: (values: Record<string, CustomFieldValueInput>) =>
      setCustomFields(contactId as string, values),
    onSuccess: (next) => {
      // Only adopt the response when it is a real save — a not-built backend answers available:false with an
      // empty list, which must NOT clobber the values already on screen.
      if (next.available) qc.setQueryData(prospectKeys.customFields(contactId ?? ""), next);
    },
  });

  return {
    feed: contactId ? (query.data ?? null) : null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load custom fields"
      : null,
    loading: query.isPending && contactId !== null,
    saving: save.isPending,
    reload: () => {
      void query.refetch();
    },
    save: async (values: Record<string, CustomFieldValueInput>): Promise<boolean> => {
      if (!contactId) return false;
      const next = await save.mutateAsync(values);
      return next.available;
    },
  };
}
