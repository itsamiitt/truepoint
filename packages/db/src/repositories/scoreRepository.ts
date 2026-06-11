// scoreRepository.ts — data access for versioned lead scores (scoring domain, ADR-0008). Every re-score
// APPENDS a row (history is the explainability trail); contacts.priority_score is synced by the DB trigger
// in rls/intel.sql, never written here.

import type { ScoreBreakdown } from "@leadwolf/types";
import { desc, eq } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { scores } from "../schema/intel.ts";

export interface ScoreInsert {
  tenantId: string;
  workspaceId: string;
  contactId: string;
  icpFit: number;
  intentScore: number;
  engagementScore: number;
  compositeScore: number;
  scoreBreakdown: ScoreBreakdown;
}

export interface ScoreHistoryRow {
  id: string;
  icpFit: number;
  intentScore: number;
  engagementScore: number;
  compositeScore: number;
  scoreBreakdown: unknown;
  scoredAt: Date;
}

export const scoreRepository = {
  async append(tx: Tx, row: ScoreInsert): Promise<string> {
    const inserted = await tx.insert(scores).values(row).returning({ id: scores.id });
    return inserted[0]!.id;
  },

  /** Newest-first score history for a contact (the detail panel's breakdown view). */
  async historyForContact(
    scope: TenantScope,
    contactId: string,
    limit = 20,
  ): Promise<ScoreHistoryRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: scores.id,
          icpFit: scores.icpFit,
          intentScore: scores.intentScore,
          engagementScore: scores.engagementScore,
          compositeScore: scores.compositeScore,
          scoreBreakdown: scores.scoreBreakdown,
          scoredAt: scores.scoredAt,
        })
        .from(scores)
        .where(eq(scores.contactId, contactId))
        .orderBy(desc(scores.scoredAt))
        .limit(limit),
    );
  },
};
