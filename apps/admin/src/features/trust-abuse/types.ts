// types.ts — the shape the Trust & abuse cockpit renders. Mirrors GET /admin/trust-abuse
// (apps/api/src/features/admin/routes.ts, backed by @leadwolf/db platformTrustReads). Counts only — non-PII;
// the api owns the canonical shape.

export interface SignupVelocity {
  d1: number;
  d7: number;
  d30: number;
  total: number;
}

export interface CountBucket {
  key: string;
  count: number;
}

export interface TrustAbuse {
  signals: {
    tenants: SignupVelocity;
    users: SignupVelocity;
    freeEmailSignups30d: number;
  };
  holds: CountBucket[];
  tenantStatus: CountBucket[];
}
