// refreshDueMailboxTokens.ts — the proactive token-refresh sweep body (M12 P1). Enumerate the mailboxes whose
// OAuth access token is within the refresh window (a CROSS-TENANT owner-connection read — ids only, no
// credential), then refresh+rotate each via getMailboxAccessToken (tenant-SCOPED; refreshes if near expiry and
// flags reauth on a dead grant). A per-mailbox error is swallowed (already flagged/logged) so one bad mailbox
// never stalls the sweep. Runs leader-locked from apps/workers; deps injected for hermetic tests.

import { mailboxRepository as defaultMailboxRepository } from "@leadwolf/db";
import { getMailboxAccessToken as defaultGetMailboxAccessToken } from "./mailboxTokenProvider.ts";

// The window must be ≥ the loader's REFRESH_SKEW so every mailbox the sweep finds actually refreshes (the loader
// only rotates within its skew; a wider window would just return still-fresh tokens untouched).
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface RefreshSweepResult {
  scanned: number;
  refreshed: number;
  failed: number;
}

export interface RefreshSweepDeps {
  listDueForRefresh: typeof defaultMailboxRepository.listDueForRefresh;
  refresh: (scope: { tenantId: string; workspaceId: string }, mailboxId: string) => Promise<string>;
}

const realDeps: RefreshSweepDeps = {
  listDueForRefresh: defaultMailboxRepository.listDueForRefresh,
  refresh: defaultGetMailboxAccessToken,
};

export async function refreshDueMailboxTokens(
  opts: { batchSize?: number } = {},
  deps: RefreshSweepDeps = realDeps,
): Promise<RefreshSweepResult> {
  const due = await deps.listDueForRefresh(REFRESH_WINDOW_MS, opts.batchSize ?? 200);
  let refreshed = 0;
  let failed = 0;
  for (const m of due) {
    try {
      await deps.refresh({ tenantId: m.tenantId, workspaceId: m.workspaceId }, m.id);
      refreshed += 1;
    } catch {
      failed += 1; // MailboxTokenError (reauth/transient) — already handled per-mailbox; keep sweeping
    }
  }
  return { scanned: due.length, refreshed, failed };
}
