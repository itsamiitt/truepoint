// crmHealthRepository.ts — the fleet-health read behind the alert tick (crm-sync 00 §9.5).
//
// ONE cross-tenant query rather than N per-connection round trips. A per-connection loop over three tables
// would be 3N queries every 60 seconds against the primary — a real cost for a health check that is silent
// most of the time.
//
// Runs on the OWNER connection because fleet health spans tenants by construction, and projects COUNTS and
// TIMESTAMPS ONLY: no credential, no customer data, nothing derived from a tenant's records. The alert
// evaluator's inputs are numbers for the same reason.

import { sql } from "drizzle-orm";
import { db } from "../client.ts";

export interface CrmHealthRow {
  connectionId: string;
  tenantId: string;
  workspaceId: string;
  status: string;
  syncMode: string;
  tokenExpiresAt: Date | null;
  deadLetters: number;
  openConflicts: number;
  newestWatermark: Date | null;
}

export const crmHealthRepository = {
  async fleetSnapshot(limit: number): Promise<CrmHealthRow[]> {
    const rows = (await db.execute(sql`
      SELECT c.id                   AS connection_id,
             c.tenant_id            AS tenant_id,
             c.workspace_id         AS workspace_id,
             c.status               AS status,
             c.sync_mode            AS sync_mode,
             c.token_expires_at     AS token_expires_at,
             COALESCE(dl.n, 0)::int AS dead_letters,
             COALESCE(cf.n, 0)::int AS open_conflicts,
             st.newest_watermark    AS newest_watermark
        FROM crm_connections c
        LEFT JOIN (SELECT connection_id, count(*) AS n FROM crm_sync_dead_letter
                    WHERE status = 'open' GROUP BY connection_id) dl ON dl.connection_id = c.id
        LEFT JOIN (SELECT connection_id, count(*) AS n FROM crm_sync_conflicts
                    WHERE status = 'open' GROUP BY connection_id) cf ON cf.connection_id = c.id
        LEFT JOIN (SELECT connection_id, max(watermark) AS newest_watermark FROM crm_sync_state
                    WHERE direction = 'inbound' GROUP BY connection_id) st ON st.connection_id = c.id
       ORDER BY c.created_at
       LIMIT ${limit}
    `)) as unknown as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      connectionId: String(r.connection_id),
      tenantId: String(r.tenant_id),
      workspaceId: String(r.workspace_id),
      status: String(r.status),
      syncMode: String(r.sync_mode),
      tokenExpiresAt: (r.token_expires_at as Date | null) ?? null,
      deadLetters: Number(r.dead_letters ?? 0),
      openConflicts: Number(r.open_conflicts ?? 0),
      newestWatermark: (r.newest_watermark as Date | null) ?? null,
    }));
  },
};
