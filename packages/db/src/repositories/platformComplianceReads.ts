// platformComplianceReads.ts — read-only compliance-ops access for the platform-admin surface (13a Area 8,
// 13 §3.8). Runs inside the audited withPlatformTx (owner connection, bypasses RLS). DSAR requests are global
// (no tenant scope — the subject spans all tenants), so this is a platform queue. PRIVACY-PRESERVING: the
// projection deliberately OMITS subject_email_enc / subject_email_blind_index / scope_report — staff oversight
// sees the request envelope (type / state / timestamps), never the subject PII or the assembled report.

import { desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { dsarRequests } from "../schema/compliance.ts";
import { PLATFORM_READ_LIMIT } from "./platformAdminReads.ts";

export interface PlatformDsarRow {
  id: string;
  requestType: string;
  status: string;
  requestedAt: Date;
  verifiedAt: Date | null;
  completedAt: Date | null;
  /** The ≤72h SLA deadline. Coalesced for rows that predate the column, so an old request reports the
   *  deadline it actually had rather than one starting at the migration. */
  dueAt: Date;
}

export const platformComplianceReadRepository = {
  /** The DSAR request queue, newest first, optionally filtered by status, bounded. PII-free projection. */
  async listDsarRequests(
    tx: Tx,
    opts: { status?: string; limit?: number } = {},
  ): Promise<PlatformDsarRow[]> {
    const limit = Math.min(opts.limit ?? 100, PLATFORM_READ_LIMIT);
    const rows = await tx
      .select({
        id: dsarRequests.id,
        requestType: dsarRequests.requestType,
        status: dsarRequests.status,
        requestedAt: dsarRequests.requestedAt,
        verifiedAt: dsarRequests.verifiedAt,
        completedAt: dsarRequests.completedAt,
        dueAt: sql<Date>`coalesce(${dsarRequests.dueAt}, ${dsarRequests.requestedAt} + interval '72 hours')`,
      })
      .from(dsarRequests)
      .where(opts.status ? eq(dsarRequests.status, opts.status) : undefined)
      .orderBy(desc(dsarRequests.id))
      .limit(limit);
    // dueAt rides a raw `sql` expression, which carries no column type for the driver to map, so it can
    // arrive as a string. Normalised here so callers never have to know which fields are really Dates.
    return rows.map((r) => ({ ...r, dueAt: new Date(r.dueAt) }));
  },
};
