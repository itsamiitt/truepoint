// platformComplianceReads.ts — read-only compliance-ops access for the platform-admin surface (13a Area 8,
// 13 §3.8). Runs inside the audited withPlatformTx (owner connection, bypasses RLS). DSAR requests are global
// (no tenant scope — the subject spans all tenants), so this is a platform queue. PRIVACY-PRESERVING: the
// projection deliberately OMITS subject_email_enc / subject_email_blind_index / scope_report — staff oversight
// sees the request envelope (type / state / timestamps), never the subject PII or the assembled report.

import { desc, eq } from "drizzle-orm";
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
}

export const platformComplianceReadRepository = {
  /** The DSAR request queue, newest first, optionally filtered by status, bounded. PII-free projection. */
  async listDsarRequests(
    tx: Tx,
    opts: { status?: string; limit?: number } = {},
  ): Promise<PlatformDsarRow[]> {
    const limit = Math.min(opts.limit ?? 100, PLATFORM_READ_LIMIT);
    return tx
      .select({
        id: dsarRequests.id,
        requestType: dsarRequests.requestType,
        status: dsarRequests.status,
        requestedAt: dsarRequests.requestedAt,
        verifiedAt: dsarRequests.verifiedAt,
        completedAt: dsarRequests.completedAt,
      })
      .from(dsarRequests)
      .where(opts.status ? eq(dsarRequests.status, opts.status) : undefined)
      .orderBy(desc(dsarRequests.id))
      .limit(limit);
  },
};
