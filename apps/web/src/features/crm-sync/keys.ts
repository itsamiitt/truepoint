// keys.ts — the CRM-sync slice's TanStack Query key factory. Single source so every read and the
// resolve-conflict mutation invalidate the SAME keys and the cache never fragments.
export const crmSyncKeys = {
  all: ["crm-sync"] as const,
  connections: () => ["crm-sync", "connections"] as const,
  runs: (connectionId: string) => ["crm-sync", "runs", connectionId] as const,
  streams: (connectionId: string) => ["crm-sync", "streams", connectionId] as const,
  conflicts: () => ["crm-sync", "conflicts"] as const,
  mappings: (connectionId: string) => ["crm-sync", "mappings", connectionId] as const,
};
