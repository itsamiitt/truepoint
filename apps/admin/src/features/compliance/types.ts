// types.ts — the shape the Compliance area renders. Mirrors the api `/admin/compliance/dsars` payload
// (apps/api/src/features/admin/compliance.ts, backed by @leadwolf/db platformComplianceReads). PII-free — the
// subject email is never carried to the client. Presentation-side type only; the api owns the canonical shape.

export interface DsarRequest {
  id: string;
  requestType: string;
  status: string;
  requestedAt: string;
  verifiedAt: string | null;
  completedAt: string | null;
}

/** A global suppression (blocklist) entry (13a Area 8). Mirrors `/admin/compliance/suppression`. */
export interface GlobalSuppression {
  id: string;
  matchType: string;
  domain: string | null;
  reason: string | null;
  createdAt: string;
}

/** A staff-authored retention policy (13a Area 8). Mirrors `/admin/compliance/retention`. */
export interface RetentionPolicy {
  id: string;
  entity: string;
  field: string | null;
  retentionDays: number;
  reason: string | null;
  active: boolean;
  updatedAt: string;
}
