// useCustomFieldDefinitions.ts — the workspace's custom-field definitions for the settings panel, plus the
// create/update actions. A 404/501 maps to available:false (backend not built) and the panel shows an honest
// empty/disabled state. Presentation state only; the API is authoritative.
//
// create/update invalidate on success, which the previous version did NOT do — they returned the API result
// and left the panel showing the pre-edit definitions until the caller happened to call reload.
"use client";

import type {
  CreateCustomFieldRequest,
  CustomFieldEntity,
  UpdateCustomFieldRequest,
} from "@leadwolf/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DefinitionsFeed, createDefinition, fetchDefinitions, updateDefinition } from "../api";
import { settingsCustomFieldKeys } from "../keys";

export function useCustomFieldDefinitions(entity: CustomFieldEntity) {
  const qc = useQueryClient();
  const key = settingsCustomFieldKeys.definitions(entity);
  const query = useQuery<DefinitionsFeed>({
    queryKey: key,
    queryFn: () => fetchDefinitions(entity),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: key });
  };

  const create = useMutation({ mutationFn: createDefinition, onSuccess: invalidate });
  const update = useMutation({
    mutationFn: (vars: { id: string; patch: UpdateCustomFieldRequest }) =>
      updateDefinition(vars.id, vars.patch),
    onSuccess: invalidate,
  });

  return {
    definitions: query.data?.definitions ?? [],
    // Defaults to false, not true: until the feed has loaded the panel must not offer editing it cannot do.
    available: query.data?.available ?? false,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load custom fields"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    create: (input: CreateCustomFieldRequest) => create.mutateAsync(input),
    update: (id: string, patch: UpdateCustomFieldRequest) => update.mutateAsync({ id, patch }),
  };
}
