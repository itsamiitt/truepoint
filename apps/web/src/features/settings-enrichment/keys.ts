// keys.ts — the settings-enrichment feature's TanStack Query key factory.
export const settingsEnrichmentKeys = {
  all: ["settings-enrichment"] as const,
  /** The tenant's auto-enrich policy. */
  autoEnrichPolicy: () => ["settings-enrichment", "auto-enrich-policy"] as const,
};
