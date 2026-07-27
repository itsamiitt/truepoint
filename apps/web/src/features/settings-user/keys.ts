// keys.ts — the settings-user feature's TanStack Query key factory. Single source so every hook and every save
// reads/invalidates the SAME keys and the cache never fragments.
export const settingsUserKeys = {
  all: ["settings-user"] as const,
  /** The editable user profile (`GET /settings/user/profile`). */
  profile: () => ["settings-user", "profile"] as const,
  /** The per-channel notification prefs (`GET /settings/user/notifications`). */
  notificationPrefs: () => ["settings-user", "notification-prefs"] as const,
};
