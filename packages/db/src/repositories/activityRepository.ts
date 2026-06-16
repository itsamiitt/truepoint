// activityRepository.ts — data access for the per-contact activity timeline (activity domain, 03 §7,
// 05 §10). Insert is tx-aware so core composes it with the contact check in ONE withTenantTx;
// contacts.last_activity_at is synced by the DB trigger in rls/activity.sql, never written here.
// String-typed like revealRepository: the closed enums live in @leadwolf/types and the CHECK constraints;
// core/api narrow at the edge.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { activities } from "../schema/activity.ts";

export interface ActivityInsert {
  tenantId: string;
  workspaceId: string;
  contactId: string;
  actorUserId?: string | null;
  activityType: string;
  channel: string;
  outcome?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

/** One timeline entry — the ActivityRow DTO shape (types/activity.ts) with DB-widened strings. */
export interface ActivityTimelineRow {
  id: string;
  contactId: string;
  actorUserId: string | null;
  activityType: string;
  channel: string;
  outcome: string | null;
  note: string | null;
  occurredAt: Date;
}

/** Grouped 30-day counts feeding the engagement score component (ADR-0008, M8). */
export interface ActivityCounts {
  total: number;
  byType: Record<string, number>;
}

export const activityRepository = {
  async insert(tx: Tx, row: ActivityInsert): Promise<string> {
    const inserted = await tx.insert(activities).values(row).returning({ id: activities.id });
    return inserted[0]!.id;
  },

  /** Newest-first timeline for the contact detail panel (05 §10). Workspace-scoped via RLS. */
  async timelineForContact(
    scope: TenantScope,
    contactId: string,
    limit = 50,
  ): Promise<ActivityTimelineRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: activities.id,
          contactId: activities.contactId,
          actorUserId: activities.actorUserId,
          activityType: activities.activityType,
          channel: activities.channel,
          outcome: activities.outcome,
          note: activities.note,
          occurredAt: activities.occurredAt,
        })
        .from(activities)
        .where(eq(activities.contactId, contactId))
        .orderBy(desc(activities.occurredAt))
        .limit(limit),
    );
  },

  /** Recent activity volume per type — the engagement component's input (one grouped count query). */
  async recentCountsForContact(tx: Tx, contactId: string, sinceDays = 30): Promise<ActivityCounts> {
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const rows = await tx
      .select({ activityType: activities.activityType, n: sql<number>`count(*)::int` })
      .from(activities)
      .where(and(eq(activities.contactId, contactId), gte(activities.occurredAt, since)))
      .groupBy(activities.activityType);
    const byType: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byType[r.activityType] = r.n;
      total += r.n;
    }
    return { total, byType };
  },

  /**
   * Workspace-wide activity counts by type over the last `sinceDays` days (no contact filter) — feeds the
   * Home sequence snapshot, where the api derives `sent` from the email_sent bucket. Workspace-scoped via RLS.
   */
  async countByTypeForWorkspace(
    scope: TenantScope,
    sinceDays = 30,
  ): Promise<Record<string, number>> {
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({ activityType: activities.activityType, n: sql<number>`count(*)::int` })
        .from(activities)
        .where(gte(activities.occurredAt, since))
        .groupBy(activities.activityType);
      const byType: Record<string, number> = {};
      for (const r of rows) byType[r.activityType] = Number(r.n);
      return byType;
    });
  },
};
