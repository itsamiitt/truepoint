// keys.ts — the public-pricing feature's TanStack Query key factory. Unauthenticated and tenant-less: the
// catalog is the same for everyone, which is what makes caching it across mounts safe.
export const publicPricingKeys = {
  all: ["public-pricing"] as const,
  /** The active plan tiers + credit packs, loaded together for one page. */
  catalog: () => ["public-pricing", "catalog"] as const,
};
