// auditRepository.ts — insert-only data access for the append-only audit_log (08 §5). Always called
// inside the same transaction as the mutation it records (14 §2); UPDATE/DELETE are blocked at the DB
// layer (trigger in rls/billing.sql), so this repository deliberately exposes no mutation helpers.

import type { AuditAction } from "@leadwolf/types";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { auditLog } from "../schema/billing.ts";

// The auth-domain slice of the audit vocabulary (ADR-0031) — what the Auth Admin ▸ Security audit shows.
const AUTH_AUDIT_ACTIONS = [
  "login.success",
  "login.failure",
  "login.locked",
  "mfa.challenge",
  "mfa.success",
  "mfa.failure",
  "password.reset.request",
  "password.reset.complete",
  "sso.initiated",
  "sso.callback",
  "token.issued",
  "token.refresh",
  "token.revoke",
  "device.trusted",
  "device.revoked",
  "session.revoked",
  "code.issued",
  "code.exchanged",
  "signup",
  "oauth.link",
] as const;

/** A shaped auth-audit row for the Security view — the security-relevant signals, never metadata/userAgent. */
export interface AuthAuditRow {
  id: string;
  action: string;
  actorUserId: string | null;
  ipAddress: string | null;
  originDomain: string | null;
  occurredAt: Date;
}

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

  /**
   * Tenant-scoped recent AUTH events (Auth Admin ▸ Security audit). Filtered to the auth action vocabulary
   * and shaped to the security-relevant fields (action / actor / ip / origin / time) — never metadata or
   * userAgent. RLS-scoped read, newest first.
   */
  async listAuthEvents(scope: TenantScope, limit = 100): Promise<AuthAuditRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: auditLog.id,
          action: auditLog.action,
          actorUserId: auditLog.actorUserId,
          ipAddress: auditLog.ipAddress,
          originDomain: auditLog.originDomain,
          occurredAt: auditLog.occurredAt,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, scope.tenantId),
            inArray(auditLog.action, [...AUTH_AUDIT_ACTIONS]),
          ),
        )
        .orderBy(desc(auditLog.occurredAt))
        .limit(limit),
    );
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
   * Pass `tx` to run on a caller's existing scoped transaction (e.g. the Home summary fan-out); omit it for
   * a standalone read.
   */
  async listByWorkspace(scope: TenantScope, limit = 15, tx?: Tx): Promise<ActivityFeedRow[]> {
    const run = (t: Tx): Promise<ActivityFeedRow[]> =>
      t
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
        .limit(limit);
    return tx ? run(tx) : withTenantTx(scope, run);
  },
};
