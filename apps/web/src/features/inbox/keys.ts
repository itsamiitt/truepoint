// keys.ts — the inbox feature's TanStack Query key factory.
export const inboxKeys = {
  all: ["inbox"] as const,
  /** The reply threads for one filter — a different filter is a different result, so it keys separately. */
  threads: (filter: string) => ["inbox", "threads", filter] as const,
  /** The task list. */
  tasks: () => ["inbox", "tasks"] as const,
};
