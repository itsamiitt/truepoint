// keys.ts — the settings-workspace feature's TanStack Query key factory. Single source so every hook and
// every save reads/invalidates the SAME keys and the cache never fragments.
export const settingsWorkspaceKeys = {
  all: ["settings-workspace"] as const,
  /** The workspace's general settings. */
  general: () => ["settings-workspace", "general"] as const,
  /** The workspace's members feed. */
  members: () => ["settings-workspace", "members"] as const,
  /** The viewer's active sessions. */
  sessions: () => ["settings-workspace", "sessions"] as const,
};
