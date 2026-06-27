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
