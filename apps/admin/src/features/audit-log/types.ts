// types.ts — the shape the Audit log area renders. Mirrors the api `/admin/audit-log` read payload
// (apps/api/src/features/admin/auditLog.ts → platformAuditReadRepository.listRecent, backed by @leadwolf/db
// platformAuditReads PlatformAuditRow). The free-form `metadata` jsonb is intentionally NOT carried to the
// client. Presentation-side type only; the api owns the canonical shape.

export interface PlatformAuditEntry {
  id: string;
  action: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  tenantId: string | null;
  workspaceId: string | null;
  ip: string | null;
  occurredAt: string;
}

/** The AND-combined filters for the audit-log viewer + export (13a F4). `since`/`until` are full ISO datetimes
 *  (the page converts the date pickers to day bounds). All optional. */
export interface AuditLogFilters {
  action?: string;
  tenantId?: string;
  actorUserId?: string;
  since?: string;
  until?: string;
}
