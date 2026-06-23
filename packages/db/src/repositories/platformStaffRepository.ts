// platformStaffRepository.ts — read the platform STAFF role (ADR-0011). platform_staff is PLATFORM-owned +
// deny-all to leadwolf_app (rls/platform.sql), so reads run on the base OWNER connection (the same
// RLS-exempt connection withPlatformTx uses, minus the audit write). This is an internal authz lookup, NOT
// a cross-tenant DATA read, so it deliberately does not write a platform_audit_log row — the audited admin
// action that follows does. Grant/revoke writes land via the platform-admin path in Phase 4.

import type { StaffRole } from "@leadwolf/types";
import { and, eq } from "drizzle-orm";
import { db } from "../client.ts";
import { platformStaff } from "../schema/auth.ts";

export const platformStaffRepository = {
  // The caller's ACTIVE staff role, or null if they are not active platform staff. Resolved per-request by
  // requireStaffRole so a revoked grant takes effect immediately (no stale-JWT window).
  async getActiveRole(userId: string): Promise<StaffRole | null> {
    const rows = await db
      .select({ staffRole: platformStaff.staffRole })
      .from(platformStaff)
      .where(and(eq(platformStaff.userId, userId), eq(platformStaff.status, "active")))
      .limit(1);
    return rows[0] ? (rows[0].staffRole as StaffRole) : null;
  },
};
