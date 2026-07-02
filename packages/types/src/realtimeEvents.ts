// realtimeEvents.ts — the shared contract for the Phase 4 realtime backbone (ADR-0027), imported by the reveal
// tx (append), the relay (publish), the SSE route (fan-out), and the web client (reconcile) so none of them
// drift. Events are PII-FREE (ids + counts + status only). The Redis pub/sub channel + the SSE `event:` name
// are one workspace-scoped topic; the outbox `id` (v7 uuid) is the SSE `id:` / last-event-id for gap-free resume.

import { z } from "zod";

// ── Event types (the `event_outbox.event_type` + SSE `event:` name) ──────────────────────────────────────
export const EVENT_REVEAL_COMPLETED = "reveal.completed";
export const EVENT_CREDITS_CHANGED = "credits.changed";
export const EVENT_REVEAL_JOB_PROGRESS = "reveal.job.progress";
export const EVENT_REVEAL_JOB_COMPLETED = "reveal.job.completed";

/** The Redis pub/sub channel a workspace's live events fan out on (one topic per workspace). */
export function workspaceEventChannel(workspaceId: string): string {
  return `rt:ws:${workspaceId}`;
}

/** The message published to Redis pub/sub AND streamed as an SSE data frame. PII-free by contract. */
export const realtimeEventSchema = z.object({
  id: z.string().uuid(), // = event_outbox.id (v7) → SSE id: / Last-Event-ID
  type: z.string(),
  workspaceId: z.string().uuid(),
  payload: z.record(z.unknown()),
});
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

// ── Payload shapes (documentation + client narrowing; all PII-free) ──────────────────────────────────────
/** reveal.completed — a single-reveal committed. The client refreshes that contact + the balance. */
export interface RevealCompletedPayload {
  contactId: string;
  revealType: string;
  creditsCharged: number;
  alreadyOwned: boolean;
  balanceAfter: number;
}

/** credits.changed — the tenant balance moved (grant / bulk lease / release / credit-back). */
export interface CreditsChangedPayload {
  balanceAfter: number;
}

/** reveal.job.progress / reveal.job.completed — the async bulk job's live counters. */
export interface RevealJobProgressPayload {
  jobId: string;
  status: string;
  processedContacts: number;
  totalContacts: number;
  revealedContacts: number;
}
