// logActivity.ts — record one timeline interaction (05 §10, M8): verify the contact exists in the scoped
// workspace and is not tombstoned, then append the activities row in the SAME withTenantTx. The DB trigger
// in rls/activity.sql maintains contacts.last_activity_at; no audit row — the activity IS the record.

import { type TenantScope, activityRepository, revealRepository, withTenantTx } from "@leadwolf/db";
import {
  type ActivityChannel,
  type ActivityOutcome,
  type ActivityType,
  NotFoundError,
} from "@leadwolf/types";

export interface LogActivityInput {
  scope: TenantScope & { workspaceId: string };
  contactId: string;
  actorUserId?: string;
  activityType: ActivityType;
  channel: ActivityChannel;
  outcome?: ActivityOutcome;
  note?: string;
  occurredAt?: Date;
}

/** Append an activity for a live, workspace-scoped contact. Returns the new activity id. */
export async function logActivity(input: LogActivityInput): Promise<string> {
  return withTenantTx(input.scope, async (tx) => {
    // RLS scopes the lookup; tombstoned (DSAR-deleted) contacts are gone for new activity too.
    const contact = await revealRepository.getContactForReveal(tx, input.contactId);
    if (!contact) throw new NotFoundError("Contact not found in this workspace.");

    return activityRepository.insert(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      contactId: input.contactId,
      actorUserId: input.actorUserId ?? null,
      activityType: input.activityType,
      channel: input.channel,
      outcome: input.outcome ?? null,
      note: input.note ?? null,
      occurredAt: input.occurredAt,
    });
  });
}
