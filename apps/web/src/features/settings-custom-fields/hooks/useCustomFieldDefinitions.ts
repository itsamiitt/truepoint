// useCustomFieldDefinitions.ts — loads the workspace's custom-field definitions for the settings panel, with a
// `reload` + create/update actions. A 404/501 maps to available:false (backend not built) → the panel shows
// an honest empty/disabled state. Presentation state only; the API is authoritative.
"use client";

import type {
  CreateCustomFieldRequest,
  CustomFieldEntity,
  UpdateCustomFieldRequest,
} from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { type DefinitionsFeed, createDefinition, fetchDefinitions, updateDefinition } from "../api";

export function useCustomFieldDefinitions(entity: CustomFieldEntity) {
  const [feed, setFeed] = useState<DefinitionsFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchDefinitions(entity));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load custom fields");
    } finally {
      setLoading(false);
    }
  }, [entity]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback((input: CreateCustomFieldRequest) => createDefinition(input), []);
  const update = useCallback(
    (id: string, patch: UpdateCustomFieldRequest) => updateDefinition(id, patch),
    [],
  );

  return {
    definitions: feed?.definitions ?? [],
    available: feed?.available ?? false,
    error,
    loading,
    reload,
    create,
    update,
  };
}
