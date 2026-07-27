// keys.ts — the settings-billing feature's TanStack Query key factory.
export const settingsBillingKeys = {
  all: ["settings-billing"] as const,
  /** The billing hub's Plan + Credits header (balance + tenant plan, loaded together). */
  overview: () => ["settings-billing", "overview"] as const,
  /** The Usage tab's paginated, filtered history — keyed by its filters. */
  usage: (filters: unknown) => ["settings-billing", "usage", filters] as const,
};
