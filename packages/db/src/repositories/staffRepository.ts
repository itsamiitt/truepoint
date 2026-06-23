// staffRepository.ts — platform STAFF RBAC writes + directory read (ADR-0011). platform_staff is
// PLATFORM-owned + deny-all to leadwolf_app (rls/platform.sql), so every call takes the owner-connection Tx
// supplied by withPlatformTx (the audited cross-tenant path) — these are NOT tenant-scoped, app-role reads.
// The granular role authz LOOKUP lives in platformStaffRepository (no audit row); these are the audited
// grant/revoke mutations + the console directory list. Email/name come from the global users row.

import type { StaffRole } from "@leadwolf/types";
import { desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { platformStaff, users } from "../schema/auth.ts";

export interface StaffMemberRow {
  userId: string;
  email: string;
  fullName: string | null;
  staffRole: string;
  status: string;
  grantedAt: Date;
}

export const staffRepository = {
  /** The platform-staff directory — every grant (active AND revoked), newest first, with the user's identity.
   *  Joined to users so the console shows email/name, not a bare id. Bounded by the (small) staff table. */
  async list(tx: Tx): Promise<StaffMemberRow[]> {
    return tx
      .select({
        userId: platformStaff.userId,
        email: users.email,
        fullName: users.fullName,
        staffRole: platformStaff.staffRole,
        status: platformStaff.status,
        grantedAt: platformStaff.grantedAt,
      })
      .from(platformStaff)
      .innerJoin(users, eq(users.id, platformStaff.userId))
      .orderBy(desc(platformStaff.grantedAt));
  },

  /** Grant (or re-grant) a staff role to a user. Upsert on the unique user_id: a fresh grant inserts; an
   *  existing row (incl. a previously revoked one) is set back to active with the new role, granted_by, a
   *  fresh granted_at, and revoked_at cleared. Idempotent for the same role. */
  async grant(
    tx: Tx,
    userId: string,
    staffRole: StaffRole,
    grantedByUserId: string,
  ): Promise<void> {
    await tx
      .insert(platformStaff)
      .values({ userId, staffRole, status: "active", grantedByUserId })
      .onConflictDoUpdate({
        target: platformStaff.userId,
        set: {
          staffRole,
          status: "active",
          grantedByUserId,
          grantedAt: sql`now()`,
          revokedAt: null,
        },
      });
  },

  /** Revoke a user's staff role: mark the row revoked + stamp revoked_at. The role lookup is resolved
   *  per-request (requireStaffRole), so a revoke takes effect on the next request — no stale-JWT window. */
  async revoke(tx: Tx, userId: string): Promise<void> {
    await tx
      .update(platformStaff)
      .set({ status: "revoked", revokedAt: sql`now()` })
      .where(eq(platformStaff.userId, userId));
  },
};
