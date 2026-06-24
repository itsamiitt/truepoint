// impersonationRepository.ts — the impersonation-with-consent audit-of-record writes/reads (ADR-0011,
// 13 §11). impersonation_sessions is PLATFORM-owned + deny-all to leadwolf_app (rls/platformOps.sql), so
// every call takes the owner-connection Tx from withPlatformTx (audited). A session is time-boxed: start
// computes expires_at = now + ttl (default 30 min) and stores the staff actor + consent `reason`; end stamps
// ended_at; listActive returns sessions that are neither ended nor expired (the banner's source of truth).
// This records the SESSION only — the scoped "login-as" access token is minted elsewhere and WIRE-deferred.

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";
import { impersonationSessions } from "../schema/platformOps.ts";

/** Default impersonation time-box. A session auto-expires after this even if never explicitly ended. */
export const IMPERSONATION_TTL_MINUTES = 30;

export interface ImpersonationStartValues {
  staffUserId: string;
  targetTenantId: string;
  targetWorkspaceId?: string | null;
  targetUserId?: string | null;
  reason: string;
  ip?: string | null;
}

export interface ImpersonationSessionRow {
  id: string;
  staffUserId: string;
  targetTenantId: string;
  targetWorkspaceId: string | null;
  targetUserId: string | null;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  ip: string | null;
}

export const impersonationRepository = {
  /** Open a time-boxed session and return its full row. expires_at is computed in SQL (now + ttl) so the
   *  bound is server-clock authoritative, never client-supplied. */
  async start(tx: Tx, input: ImpersonationStartValues): Promise<ImpersonationSessionRow> {
    const rows = await tx
      .insert(impersonationSessions)
      .values({
        staffUserId: input.staffUserId,
        targetTenantId: input.targetTenantId,
        targetWorkspaceId: input.targetWorkspaceId ?? null,
        targetUserId: input.targetUserId ?? null,
        reason: input.reason,
        ip: input.ip ?? null,
        expiresAt: sql`now() + (${IMPERSONATION_TTL_MINUTES} * interval '1 minute')`,
      })
      .returning();
    return rows[0] as ImpersonationSessionRow;
  },

  /** The target tenant of a session — resolved on the base OWNER connection (the table denies leadwolf_app),
   *  the same un-audited internal-lookup pattern as platformStaffRepository.getActiveRole. Used to stamp the
   *  `.end` audit row with the tenant BEFORE the audited tx runs (withPlatformTx writes its audit row at tx
   *  start from the target passed in, so the tenant must be resolved first — this makes `admin.impersonate.end`
   *  tenant-attributed and surface in the customer's staff-access log symmetrically with `.start`). null for an
   *  unknown id. */
  async getTargetTenant(id: string): Promise<string | null> {
    const rows = await db
      .select({ targetTenantId: impersonationSessions.targetTenantId })
      .from(impersonationSessions)
      .where(eq(impersonationSessions.id, id))
      .limit(1);
    return rows[0]?.targetTenantId ?? null;
  },

  /** End a session early: stamp ended_at = now. Idempotent (re-ending an ended session is a harmless update).
   *  Returns the count of rows touched so the caller can 404 an unknown id. */
  async end(tx: Tx, id: string): Promise<number> {
    const rows = await tx
      .update(impersonationSessions)
      .set({ endedAt: sql`now()` })
      .where(eq(impersonationSessions.id, id))
      .returning({ id: impersonationSessions.id });
    return rows.length;
  },

  /** Sessions that are still live: not explicitly ended AND not past expires_at. The banner's source. */
  async listActive(tx: Tx): Promise<ImpersonationSessionRow[]> {
    return tx
      .select()
      .from(impersonationSessions)
      .where(
        and(isNull(impersonationSessions.endedAt), gt(impersonationSessions.expiresAt, sql`now()`)),
      )
      .orderBy(desc(impersonationSessions.startedAt));
  },
};
