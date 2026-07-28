// types.ts — the staff CRM-sync monitor's view models (crm-sync 00 §9).
//
// Operational columns ONLY. There is deliberately no field here for a credential, a contact, or anything
// derived from tenant data: a cross-tenant staff console must not become a window onto customer records, and
// the shape is the cheapest place to make that structural rather than a convention.

export interface StaffCrmConnection {
  id: string;
  tenantId: string;
  workspaceId: string;
  provider: string;
  status: string;
  /** The L3 gate. 'shadow' = connected and counting, writing nothing to the customer's CRM. */
  syncMode: string;
  environment: string;
  externalAccountId: string | null;
  lastError: string | null;
  lastRefreshAt: string | null;
  tokenExpiresAt: string | null;
  nextPollAt: string | null;
  connectedAt: string | null;
}

/**
 * One dead-lettered CRM job, as the staff console sees it.
 *
 * PII-free by construction: `errorDetail` is scrubbed on the write path, `crmRecordId` is an opaque provider
 * id and `tpEntityId` is an id with no record attached. There is deliberately no field here for the record
 * that failed — a triage console must not become a cross-tenant window onto customer data.
 */
export interface StaffCrmDeadLetter {
  id: string;
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  queue: string;
  direction: string | null;
  objectType: string | null;
  crmRecordId: string | null;
  tpEntityId: string | null;
  errorClass: string;
  errorDetail: string | null;
  attempts: number;
  firstSeenAt: string;
  lastSeenAt: string;
}
