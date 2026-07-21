// types.ts — the Sync status slice's view model. Mirrors the forge-api `/bff/sync-status` payload; the console
// owns no schema of record.

export interface SyncTarget {
  id: string;
  destination: string;
  status: string;
  /** Records still queued for this destination. */
  pending: number;
  lastSyncedAt: string | null;
}

export interface SyncStatusResponse {
  targets: SyncTarget[];
}
