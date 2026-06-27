// jitElevationRepository.ts — data access for jit_elevations (ADR-0011 / 13a F1). Every method takes the
// transaction handed by withPlatformTx (owner connection, audited): `grant` mints a time-boxed elevation,
// `consume` atomically spends one for a gated action, `listActive` feeds the console. The consume is the
// security-critical bit — it must be a single atomic statement so two concurrent actions can never spend the
// same grant (FOR UPDATE SKIP LOCKED on the matched row). Composed INSIDE the gated action's own tx, so a
// rejected action (no-op / overdraw) rolls the consume back and the grant stays live.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/** Default elevation lifetime — short by design (13 §2 "time-boxed"): long enough to complete the action,
 *  short enough that a stale session can't sit on standing privilege. */
export const JIT_ELEVATION_TTL_SECONDS = 600; // 10 minutes

export interface GrantElevationInput {
  staffUserId: string;
  action: string; // a jitAction class
  reason: string;
  targetTenantId: string;
  ttlSeconds: number;
  ip?: string | null;
}

export interface JitElevationRow {
  id: string;
  staffUserId: string;
  action: string;
  reason: string;
  targetTenantId: string | null;
  status: string;
  grantedAt: Date;
  expiresAt: Date;
}

const VIEW_COLS = sql`id, staff_user_id AS "staffUserId", action, reason,
  target_tenant_id AS "targetTenantId", status, granted_at AS "grantedAt", expires_at AS "expiresAt"`;

export const jitElevationRepository = {
  /** Mint a time-boxed, tenant-scoped elevation for `action`. expires_at is server-computed (never client). */
  async grant(tx: Tx, input: GrantElevationInput): Promise<JitElevationRow> {
    const rows = (await tx.execute(
      sql`INSERT INTO jit_elevations (staff_user_id, action, reason, target_tenant_id, expires_at, ip)
          VALUES (${input.staffUserId}::uuid, ${input.action}, ${input.reason},
                  ${input.targetTenantId}::uuid,
                  now() + (${input.ttlSeconds}::int * interval '1 second'), ${input.ip ?? null})
          RETURNING ${VIEW_COLS}`,
    )) as unknown as JitElevationRow[];
    return rows[0]!;
  },

  /**
   * Atomically spend ONE active, unexpired elevation matching (staff, action, target). Returns the consumed
   * grant's id + reason, or null if the caller holds none. The matched row is picked + locked in a single
   * statement (FOR UPDATE SKIP LOCKED), so two concurrent gated actions can never spend the same grant — one
   * wins, the other sees null and is told to elevate. Composed inside the action's tx: if the action later
   * throws, this UPDATE rolls back and the elevation is live again.
   */
  async consume(
    tx: Tx,
    match: { staffUserId: string; action: string; targetTenantId: string },
  ): Promise<{ id: string; reason: string } | null> {
    const rows = (await tx.execute(
      sql`UPDATE jit_elevations SET status = 'consumed', consumed_at = now()
          WHERE id = (
            SELECT id FROM jit_elevations
            WHERE staff_user_id = ${match.staffUserId}::uuid
              AND action = ${match.action}
              AND target_tenant_id = ${match.targetTenantId}::uuid
              AND status = 'active'
              AND expires_at > now()
            ORDER BY expires_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, reason`,
    )) as unknown as Array<{ id: string; reason: string }>;
    return rows.length > 0 ? { id: rows[0]!.id, reason: rows[0]!.reason } : null;
  },

  /** The caller's currently-live elevations (active + unexpired), soonest-expiring first. Bounded. */
  async listActive(tx: Tx, staffUserId: string): Promise<JitElevationRow[]> {
    return (await tx.execute(
      sql`SELECT ${VIEW_COLS} FROM jit_elevations
          WHERE staff_user_id = ${staffUserId}::uuid AND status = 'active' AND expires_at > now()
          ORDER BY expires_at ASC
          LIMIT 100`,
    )) as unknown as JitElevationRow[];
  },
};
