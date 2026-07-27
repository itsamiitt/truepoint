// keys.ts — the settings-developer feature's TanStack Query key factory. Single source so every hook and every
// mutation reads/invalidates the SAME keys and the cache never fragments.
export const settingsDeveloperKeys = {
  all: ["settings-developer"] as const,
  /** The tenant's API keys (`GET /tenants/me/api-keys`). */
  apiKeys: () => ["settings-developer", "api-keys"] as const,
  /** The tenant's registered OAuth apps. */
  oauthApps: () => ["settings-developer", "oauth-apps"] as const,
  /** The tenant's webhook endpoints. */
  webhooks: () => ["settings-developer", "webhooks"] as const,
  /** Recent webhook delivery attempts. */
  webhookDeliveries: () => ["settings-developer", "webhook-deliveries"] as const,
};
