// keys.ts — the settings-mailboxes feature's TanStack Query key factory. Single source so every hook and every save
// reads/invalidates the SAME keys and the cache never fragments.
export const settingsMailboxKeys = {
  all: ["settings-mailboxes"] as const,
  /** The connected mailboxes (`GET /settings/mailboxes`). */
  mailboxes: () => ["settings-mailboxes", "list"] as const,
  /** The sending domains and their verification state. */
  sendingDomains: () => ["settings-mailboxes", "sending-domains"] as const,
};
