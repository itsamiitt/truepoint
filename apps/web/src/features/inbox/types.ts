// types.ts — the Inbox slice's view shapes (replies + tasks). The reply-ingestion + task backends are an M9
// design gate (mailbox sync: direct Gmail/Graph vs a unified-inbox vendor), so these are documented-contract
// shapes the UI renders against; when the backend isn't built the api layer reports `available:false` and the
// surfaces show first-class empty states (never fabricated threads/tasks).

export type ReplyChannel = "email" | "linkedin";

/** Which slice of replies to show (11 §4.4). */
export type InboxFilter = "mine" | "unassigned" | "sequence";

export interface InboxMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  /** ISO timestamp. */
  at: string;
}

export interface InboxThread {
  id: string;
  contactId: string;
  /** Display name (masking is enforced server-side). */
  contactName: string;
  contactTitle?: string | null;
  accountName?: string | null;
  sequenceId?: string | null;
  sequenceName?: string | null;
  channel: ReplyChannel;
  /** Last-message preview. */
  snippet: string;
  unread: boolean;
  assigneeId?: string | null;
  /** ISO timestamp of the latest message. */
  lastMessageAt: string;
  /** Populated only on the detail fetch. */
  messages?: InboxMessage[];
}

/** A list response; `available` is false when the backend route isn't built yet (M9). */
export interface InboxFeed {
  available: boolean;
  threads: InboxThread[];
}

export type TaskStatus = "open" | "done" | "snoozed";

/** What created the task — manual or a system signal (11 §4.4). */
export type TaskSource =
  | "manual"
  | "reply"
  | "follow_up"
  | "low_credits"
  | "import"
  | "dsar";

export interface InboxTask {
  id: string;
  title: string;
  status: TaskStatus;
  source: TaskSource;
  /** ISO timestamp or null for no due date. */
  dueAt?: string | null;
  contactName?: string | null;
  /** ISO timestamp. */
  createdAt: string;
}

export interface TaskFeed {
  available: boolean;
  tasks: InboxTask[];
}

/** Human label for a task's source signal. */
export const TASK_SOURCE_LABEL: Record<TaskSource, string> = {
  manual: "Task",
  reply: "Reply",
  follow_up: "Follow-up",
  low_credits: "Credits",
  import: "Import",
  dsar: "Compliance",
};
