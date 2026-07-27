// keys.ts — the settings-custom-fields feature's TanStack Query key factory.
export const settingsCustomFieldKeys = {
  all: ["settings-custom-fields"] as const,
  /** The workspace's custom-field definitions for one entity type. */
  definitions: (entity: string) => ["settings-custom-fields", "definitions", entity] as const,
};
