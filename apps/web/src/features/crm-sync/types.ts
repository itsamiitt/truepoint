// types.ts — the CRM-sync slice's view models (crm-sync 00 §9). Presentation shapes only: the API returns
// exactly these, and none of them can carry a credential — the repository's safeColumns projection omits
// oauth_token_enc, so there is no field here to leak into.

export interface CrmConnectionView {
  id: string;
  provider: string;
  status: string;
  /** The L3 dark-launch gate. 'shadow' means the engine counts but writes nothing to the CRM. */
  syncMode: string;
  environment: string;
  externalAccountId: string | null;
  instanceUrl: string | null;
  lastError: string | null;
  lastRefreshAt: string | null;
  connectedAt: string | null;
}

export interface CrmSyncRunView {
  id: string;
  direction: string;
  objectType: string;
  trigger: string;
  /** Snapshot of sync_mode at run time — what makes a shadow run's counts readable as "did not write". */
  mode: string;
  status: string;
  recordsSeen: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsFailed: number;
  recordsConflicted: number;
  apiCalls: number;
  startedAt: string;
  finishedAt: string | null;
  failedReason: string | null;
}

export interface CrmSyncStreamView {
  id: string;
  objectType: string;
  direction: string;
  watermark: string | null;
  backfillStatus: string;
}

/** A conflict row. tpValue/crmValue are ALREADY PII-masked by the repository's write path (§4.7) — this
 *  view renders whatever it is given and must never try to "un-mask" or re-fetch the real value. */
export interface CrmConflictView {
  id: string;
  connectionId: string;
  objectType: string;
  field: string;
  tpValue: string | null;
  crmValue: string | null;
  createdAt: string;
}

/** One field mapping as the editor sees it (§4.3). */
export interface CrmMappingView {
  id: string;
  objectType: string;
  tpField: string;
  crmField: string;
  direction: string;
  authority: string;
  transform: string;
  isRequired: boolean;
  enabled: boolean;
}
