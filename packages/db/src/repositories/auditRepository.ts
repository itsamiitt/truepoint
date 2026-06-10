// auditRepository.ts — insert-only data access for the append-only audit_log (08 §5). Always called
// inside the same transaction as the mutation it records (14 §2); UPDATE/DELETE are blocked at the DB
// layer (trigger in rls/billing.sql), so this repository deliberately exposes no mutation helpers.

import type { AuditAction } from "@leadwolf/types";
import { desc, eq } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { auditLog } from "../schema/billing.ts";

export interface AuditEntryInput {
  tenantId: string;
  workspaceId?: string | null; // null = tenant-level action
  actorUserId?: string | null; // null = system/automation
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  originDomain?: string | null;
}

export const auditRepository = {
  async insert(tx: Tx, entry: AuditEntryInput): Promise<void> {
    await tx.insert(auditLog).values({ ...entry, metadata: entry.metadata ?? {} });
  },

  /** Tenant-scoped recent entries (Settings ▸ Compliance audit viewer, M5). */
  async listByTenant(scope: TenantScope, limit = 100) {
    return withTenantTx(scope, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, scope.tenantId))
        .orderBy(desc(auditLog.occurredAt))
        .limit(limit),
    );
  },
};
