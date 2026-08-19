// accountScoreRepository.ts — data access for account-grain scoring (0129, MI-S4). Tenant functions run
// inside the caller's withTenantTx (RLS); the census is SYSTEM-only on the owner connection, ids only —
// the jobChangeSweep/signalFanout twin.

import { sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";

export interface AppendAccountScoreInput {
  tenantId: string;
  workspaceId: string;
  accountId: string;
  modelVersion: string;
  icpFit: number;
  momentum: number;
  composite: number;
  breakdown: Record<string, unknown>;
}

export const accountScoreRepository = {
  /** Append one versioned score row (the trigger syncs accounts.icp_fit_score). */
  async append(tx: Tx, input: AppendAccountScoreInput): Promise<string> {
    const rows = (await tx.execute(
      sql`INSERT INTO account_scores
            (tenant_id, workspace_id, account_id, model_version, icp_fit, momentum, composite, breakdown)
          VALUES (${input.tenantId}::uuid, ${input.workspaceId}::uuid, ${input.accountId}::uuid,
                  ${input.modelVersion}, ${input.icpFit}, ${input.momentum}, ${input.composite},
                  ${JSON.stringify(input.breakdown)}::jsonb)
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    return rows[0]!.id;
  },

  /** Whether the account carries a canonical industry node (0128) — a fit input the masked DTO omits. */
  async hasIndustryNode(tx: Tx, accountId: string): Promise<boolean> {
    const rows = (await tx.execute(
      sql`SELECT (industry_id IS NOT NULL) AS has_node FROM accounts WHERE id = ${accountId}::uuid`,
    )) as unknown as Array<{ has_node: boolean }>;
    return rows[0]?.has_node ?? false;
  },

  /** Accounts in THIS workspace holding a signal delivered since `since` — the rescore worklist. */
  async listAccountsWithNewSignals(tx: Tx, since: Date, limit = 200): Promise<string[]> {
    const rows = (await tx.execute(
      sql`SELECT DISTINCT account_id FROM tenant_signals
           WHERE account_id IS NOT NULL AND delivered_at > ${since.toISOString()}::timestamptz
           LIMIT ${limit}`,
    )) as unknown as Array<{ account_id: string }>;
    return rows.map((r) => r.account_id);
  },

  /**
   * SYSTEM census (owner connection, ids only — the C-02 boundary): workspaces holding a tenant signal
   * delivered since the watermark. NOT reachable from a tenant request.
   */
  async listWorkspacesWithNewSignals(
    since: Date,
    limit = 200,
  ): Promise<Array<{ tenantId: string; workspaceId: string }>> {
    const rows = (await db.execute(
      sql`SELECT DISTINCT tenant_id, workspace_id FROM tenant_signals
           WHERE delivered_at > ${since.toISOString()}::timestamptz
           LIMIT ${limit}`,
    )) as unknown as Array<{ tenant_id: string; workspace_id: string }>;
    return rows.map((r) => ({ tenantId: r.tenant_id, workspaceId: r.workspace_id }));
  },
};
