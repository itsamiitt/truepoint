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
