// auditRepository.ts — insert-only data access for the append-only audit_log (08 §5). Always called
// inside the same transaction as the mutation it records (14 §2); UPDATE/DELETE are blocked at the DB
// layer (trigger in rls/billing.sql), so this repository deliberately exposes no mutation helpers.

import type { AuditAction } from "@leadwolf/types";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { auditLog } from "../schema/billing.ts";

/** A minimized audit entry for the Home activity feed — NO metadata/ip/userAgent (never leak PII). */
export interface ActivityFeedRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  occurredAt: Date;
}

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

  /**
   * Workspace activity feed for the Home dashboard — this workspace's rows PLUS tenant-level rows
   * (workspace_id IS NULL), newest first. MINIMIZED PROJECTION: metadata/ip/userAgent are NEVER selected
   * (those carry PII). Distinct from listByTenant, which returns the raw rows for the compliance viewer.
   */
  async listByWorkspace(scope: TenantScope, limit = 15): Promise<ActivityFeedRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: auditLog.id,
          action: auditLog.action,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          actorUserId: auditLog.actorUserId,
          occurredAt: auditLog.occurredAt,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, scope.tenantId),
            or(
              scope.workspaceId ? eq(auditLog.workspaceId, scope.workspaceId) : undefined,
              isNull(auditLog.workspaceId),
            ),
          ),
        )
        .orderBy(desc(auditLog.occurredAt))
        .limit(limit),
    );
  },
};
