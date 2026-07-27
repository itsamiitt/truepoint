// keys.ts — the settings-tenant feature's TanStack Query key factory. Single source so every hook and every save
// reads/invalidates the SAME keys and the cache never fragments.
export const settingsTenantKeys = {
  all: ["settings-tenant"] as const,
  /** The tenant auth policy (Tenant ▸ Security & access). */
  authPolicy: () => ["settings-tenant", "auth-policy"] as const,
  /** The tenant SSO configuration. */
  ssoConfig: () => ["settings-tenant", "sso-config"] as const,
  /** The organization profile + its workspaces and members. */
  organization: () => ["settings-tenant", "organization"] as const,
  /** Verified domains and their claim tokens. */
  identity: () => ["settings-tenant", "identity"] as const,
};
