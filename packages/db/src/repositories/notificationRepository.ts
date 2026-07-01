// notificationRepository.ts — data access for the in-app notification feed (G-NTF-1). Workspace-scoped via RLS
// (rls/notifications.sql); PER-USER visibility is enforced HERE by a user_id predicate on every read/write (the
// RLS GUC carries no user id). Reads are keyset-paginated over the v7 id (newest-first). Producers `create` a
// notification inside their own withTenantTx (the workspace GUC must be set for the RLS WITH CHECK).

import type { NotificationType } from "@leadwolf/types";
import { and, count, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { notifications } from "../schema/notifications.ts";

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface CreateNotificationInput {
  tenantId: string;
  workspaceId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

const NOTIF_COLS = {
  id: notifications.id,
  type: notifications.type,
  title: notifications.title,
  body: notifications.body,
  entityType: notifications.entityType,
  entityId: notifications.entityId,
  readAt: notifications.readAt,
  createdAt: notifications.createdAt,
};

const FEED_PAGE_MAX = 50;

// Opaque keyset cursor over the time-ordered v7 id (id DESC newest-first; id < cursor pages older). base64url.
function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}
function decodeCursor(cursor: string): string | null {
  try {
    return Buffer.from(cursor, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

export const notificationRepository = {
  /** Insert one notification for a recipient. Composed inside the caller's withTenantTx (the workspace GUC must
   *  be set for the RLS WITH CHECK). Returns the new id. */
  async create(tx: Tx, input: CreateNotificationInput): Promise<string> {
    const [row] = await tx
      .insert(notifications)
      .values({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      })
      .returning({ id: notifications.id });
    return row?.id ?? "";
  },

  /** Does the user already have an UNREAD notification of this type in this workspace? Producers use this to
   *  dedup (don't re-notify a still-unacknowledged condition, e.g. daily low-credits). Takes an explicit tx +
   *  workspace/user — the owner-connection producer path has no GUC, so the predicates ARE the scope. */
  async existsUnreadOfType(
    tx: Tx,
    workspaceId: string,
    userId: string,
    type: NotificationType,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ one: sql<number>`1` })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.userId, userId),
          eq(notifications.type, type),
          isNull(notifications.readAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  },

  /** A keyset page of the caller's OWN notifications (newest-first), workspace + user scoped. */
  async listForUser(
    scope: TenantScope,
    userId: string,
    opts: { limit?: number; cursor?: string } = {},
    tx?: Tx,
  ): Promise<{ rows: NotificationRow[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), FEED_PAGE_MAX);
    const cursorId = opts.cursor ? decodeCursor(opts.cursor) : null;
    const run = async (t: Tx): Promise<{ rows: NotificationRow[]; nextCursor: string | null }> => {
      const conds = [eq(notifications.userId, userId)];
      if (cursorId) conds.push(lt(notifications.id, cursorId));
      const rows = (await t
        .select(NOTIF_COLS)
        .from(notifications)
        .where(and(...conds))
        .orderBy(desc(notifications.id))
        .limit(limit + 1)) as NotificationRow[];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return { rows: page, nextCursor: hasMore && last ? encodeCursor(last.id) : null };
    };
    return tx ? run(tx) : withTenantTx(scope, run);
  },

  /** Count the caller's unread notifications (partial-index-backed). */
  async unreadCount(scope: TenantScope, userId: string, tx?: Tx): Promise<number> {
    const run = async (t: Tx): Promise<number> => {
      const [row] = await t
        .select({ value: count() })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
      return Number(row?.value ?? 0);
    };
    return tx ? run(tx) : withTenantTx(scope, run);
  },

  /** Mark ONE notification read — only the caller's own, only if currently unread. Returns true if updated. */
  async markRead(scope: TenantScope, userId: string, id: string, tx?: Tx): Promise<boolean> {
    const run = async (t: Tx): Promise<boolean> => {
      const updated = await t
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.userId, userId),
            isNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id });
      return updated.length > 0;
    };
    return tx ? run(tx) : withTenantTx(scope, run);
  },

  /** Mark ALL the caller's unread notifications read. Returns the count updated. */
  async markAllRead(scope: TenantScope, userId: string, tx?: Tx): Promise<number> {
    const run = async (t: Tx): Promise<number> => {
      const updated = await t
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
        .returning({ id: notifications.id });
      return updated.length;
    };
    return tx ? run(tx) : withTenantTx(scope, run);
  },
};
