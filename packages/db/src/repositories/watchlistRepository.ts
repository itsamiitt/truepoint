// watchlistRepository.ts — watchlists + members + signal subscriptions (market-intelligence MI-S5).
// Every function runs inside the caller's withTenantTx; RLS bounds the workspace, and per-USER reads of
// subscriptions carry an explicit user_id predicate (the notifications posture — the GUC has no user).

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

export interface WatchlistRow {
  id: string;
  name: string;
  memberCount: number;
  createdAt: Date;
  /** The CALLER's subscribed families on this list (empty = not subscribed or paused). */
  myFamilies: string[];
}

export const watchlistRepository = {
  async create(
    tx: Tx,
    input: { tenantId: string; workspaceId: string; name: string; createdByUserId: string },
  ): Promise<string> {
    const rows = (await tx.execute(
      sql`INSERT INTO watchlists (tenant_id, workspace_id, name, created_by_user_id)
          VALUES (${input.tenantId}::uuid, ${input.workspaceId}::uuid, ${input.name}, ${input.createdByUserId}::uuid)
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    return rows[0]!.id;
  },

  /** All watchlists in the workspace, each carrying THE CALLER's subscription families (hydration for the
   *  UI's toggles — one fetch, no per-list subscription read). userId is an explicit predicate, never RLS. */
  async list(tx: Tx, userId: string): Promise<WatchlistRow[]> {
    const rows = (await tx.execute(
      sql`SELECT w.id, w.name, w.created_at,
                 (SELECT count(*)::int FROM watchlist_members m WHERE m.watchlist_id = w.id) AS member_count,
                 coalesce(s.families, '{}'::text[]) AS my_families
            FROM watchlists w
            LEFT JOIN signal_subscriptions s
              ON s.watchlist_id = w.id AND s.user_id = ${userId}::uuid
           ORDER BY w.name`,
    )) as unknown as Array<{
      id: string;
      name: string;
      created_at: Date;
      member_count: number;
      my_families: string[];
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      memberCount: r.member_count,
      createdAt: new Date(r.created_at),
      myFamilies: r.my_families ?? [],
    }));
  },

  async remove(tx: Tx, watchlistId: string): Promise<boolean> {
    const rows = (await tx.execute(
      sql`DELETE FROM watchlists WHERE id = ${watchlistId}::uuid RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    return rows.length > 0;
  },

  /** Idempotent membership add — re-adding is a no-op, not an error. */
  async addMember(
    tx: Tx,
    input: {
      tenantId: string;
      workspaceId: string;
      watchlistId: string;
      accountId: string;
      addedByUserId: string;
    },
  ): Promise<boolean> {
    const rows = (await tx.execute(
      sql`INSERT INTO watchlist_members (tenant_id, workspace_id, watchlist_id, account_id, added_by_user_id)
          SELECT ${input.tenantId}::uuid, ${input.workspaceId}::uuid, w.id, a.id, ${input.addedByUserId}::uuid
            FROM watchlists w, accounts a
           WHERE w.id = ${input.watchlistId}::uuid
             AND a.id = ${input.accountId}::uuid
             AND a.deleted_at IS NULL
          ON CONFLICT (watchlist_id, account_id) DO NOTHING
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    return rows.length > 0;
  },

  async removeMember(tx: Tx, watchlistId: string, accountId: string): Promise<boolean> {
    const rows = (await tx.execute(
      sql`DELETE FROM watchlist_members
           WHERE watchlist_id = ${watchlistId}::uuid AND account_id = ${accountId}::uuid
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    return rows.length > 0;
  },

  async listMemberAccountIds(tx: Tx, watchlistId: string): Promise<string[]> {
    const rows = (await tx.execute(
      sql`SELECT account_id FROM watchlist_members WHERE watchlist_id = ${watchlistId}::uuid`,
    )) as unknown as Array<{ account_id: string }>;
    return rows.map((r) => r.account_id);
  },

  /** Upsert THIS user's subscription on a watchlist. Empty families = paused, row kept. */
  async subscribe(
    tx: Tx,
    input: {
      tenantId: string;
      workspaceId: string;
      watchlistId: string;
      userId: string;
      families: readonly string[];
    },
  ): Promise<void> {
    const familiesArr = input.families.length
      ? sql`ARRAY[${sql.join(
          input.families.map((f) => sql`${f}`),
          sql`, `,
        )}]::text[]`
      : sql`'{}'::text[]`;
    await tx.execute(
      sql`INSERT INTO signal_subscriptions (tenant_id, workspace_id, watchlist_id, user_id, families)
          VALUES (${input.tenantId}::uuid, ${input.workspaceId}::uuid, ${input.watchlistId}::uuid,
                  ${input.userId}::uuid, ${familiesArr})
          ON CONFLICT (watchlist_id, user_id)
          DO UPDATE SET families = EXCLUDED.families, updated_at = now()`,
    );
  },

  /**
   * The DISPATCH join: users subscribed (via any watchlist containing this account) to this signal
   * family. Distinct — a user watching the account through two lists gets one notification.
   */
  async subscribersFor(tx: Tx, accountId: string, family: string): Promise<string[]> {
    const rows = (await tx.execute(
      sql`SELECT DISTINCT s.user_id
            FROM signal_subscriptions s
            JOIN watchlist_members m ON m.watchlist_id = s.watchlist_id
           WHERE m.account_id = ${accountId}::uuid
             AND ${family} = ANY(s.families)`,
    )) as unknown as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  },
};
