// useCustomFields.ts — loads one contact's custom-field values (ADR-0028) for the record-detail Drawer, with a
// `reload` + a `save` that shallow-merges edits. The custom-fields backend is an M8 gate, so api.fetchCustomFields
// maps a 404/501 to available:false and this hook surfaces that as an empty (not error) state. Presentation only.
"use client";

import type { CustomFieldValueInput } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { type CustomFieldsFeed, fetchCustomFields, setCustomFields } from "../api";

export function useCustomFields(contactId: string | null) {
  const [feed, setFeed] = useState<CustomFieldsFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (!contactId) {
      setFeed(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchCustomFields(contactId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load custom fields");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (values: Record<string, CustomFieldValueInput>): Promise<boolean> => {
      if (!contactId) return false;
      setSaving(true);
      try {
        const next = await setCustomFields(contactId, values);
        // Only adopt the response when it's a real save — a not-built backend returns available:false with an
        // empty list, which must NOT clobber the values already on screen.
        if (next.available) setFeed(next);
        return next.available;
      } finally {
        setSaving(false);
      }
    },
    [contactId],
  );

  return { feed, error, loading, saving, reload, save };
}
