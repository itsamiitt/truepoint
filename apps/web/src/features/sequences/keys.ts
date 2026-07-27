// keys.ts — the sequences feature's TanStack Query key factory. Single source so every hook and every action
// reads/invalidates the SAME keys and the cache never fragments.
export const sequenceKeys = {
  all: ["sequences"] as const,
  /** The workspace's sequences (the list view). */
  list: () => ["sequences", "list"] as const,
  /** The message-template library for one status — active library vs archived bin are different results. */
  templates: (status: string) => ["sequences", "templates", status] as const,
  /** One sequence's enrollment log. */
  enrollmentLog: (sequenceId: string) => ["sequences", "enrollment-log", sequenceId] as const,
  /** The workspace's masked contacts, as the enrollment picker's source. */
  enrollableContacts: () => ["sequences", "enrollable-contacts"] as const,
  /** AI/manual outreach drafts (post-MVP backend; reports itself unavailable when unwired). */
  drafts: () => ["sequences", "drafts"] as const,
};
