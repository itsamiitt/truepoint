// keys.ts — the sales-navigator feature's TanStack Query key factory.
export const salesNavKeys = {
  all: ["sales-navigator"] as const,
  /** The workspace's captured Sales Navigator links. */
  links: () => ["sales-navigator", "links"] as const,
};
