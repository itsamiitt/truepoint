// ingestTrackingEvent.ts — the tracking firehose → product timeline projection (M12 P3, 04, 15 §A.2). A
// verified ESP/open-pixel/click event is recorded idempotently in the high-volume email_event store, and the
// engagement signals (open/click) are projected into `activities` (email_opened / email_clicked) so the
// per-contact timeline — which already reads activities — lights up. email_event FEEDS activities, it does
// not replace it (D11). Idempotent on provider_event_id: a duplicate (MPP/prefetch refire) is a no-op, so an
// inflated open never double-counts (D6 — opens are informational). delivery/bounce/complaint/unsubscribe are
// recorded in email_event but not projected as timeline activities (bounce/complaint route to handleBounce at
// the webhook; reply detection + the unified inbox arrive with mailbox-sync). All in ONE tenant tx.

import {
  type EmailEventType,
  type TenantScope,
  activityRepository,
  emailEventRepository,
  withTenantTx,
} from "@leadwolf/db";

export interface TrackingEventInput {
  type: EmailEventType;
  contactId?: string | null;
  outreachLogId?: string | null;
  messageId?: string | null;
  providerEventId: string; // the idempotency key (email_event.provider_event_id)
  isMppSuspected?: boolean;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

/** Engagement events that become a timeline activity. */
const ACTIVITY_TYPE: Partial<Record<EmailEventType, string>> = {
  open: "email_opened",
  click: "email_clicked",
};

export async function ingestTrackingEvent(
  scope: TenantScope & { workspaceId: string },
  event: TrackingEventInput,
): Promise<{ ingested: boolean }> {
  return withTenantTx<{ ingested: boolean }>(scope, async (tx) => {
    const eventId = await emailEventRepository.ingest(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      outreachLogId: event.outreachLogId ?? null,
      contactId: event.contactId ?? null,
      messageId: event.messageId ?? null,
      eventType: event.type,
      providerEventId: event.providerEventId,
      isMppSuspected: event.isMppSuspected ?? false,
      occurredAt: event.occurredAt ?? new Date(),
      metadata: event.metadata,
    });
    // Duplicate provider event → no-op (idempotent; never re-project).
    if (eventId === null) return { ingested: false };

    const activityType = ACTIVITY_TYPE[event.type];
    if (activityType && event.contactId) {
      await activityRepository.insert(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        contactId: event.contactId,
        actorUserId: null, // system: the tracking pipeline, not a user
        activityType,
        channel: "email",
        occurredAt: event.occurredAt ?? new Date(),
        metadata: { emailEventId: eventId, isMppSuspected: event.isMppSuspected ?? false },
      });
    }
    return { ingested: true };
  });
}
