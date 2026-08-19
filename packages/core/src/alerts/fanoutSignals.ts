// fanoutSignals.ts — the per-workspace DELIVERY + DISPATCH step of the signal fan-out
// (market-intelligence MI-S6 delivery + MI-S5 subscriptions; docs/planning/market-intelligence/06 §2/§3).
// Outcomes: [S-13][S-09][S-14].
//
// The sweep (apps/workers signalFanout) does the census on the owner connection; THIS function is the
// tenant half: one withTenantTx per workspace, RLS ENFORCING —
//   1. project each Layer-0 company signal onto the workspace's bridged accounts (tenant_signals);
//   2. for each row ACTUALLY written, notify exactly the users subscribed to that account's watchlists
//      for that signal family (MI-S5: the feed is browse, the notification is opt-in).
// Redelivery collapses on the (workspace, master_signal_id) unique wall, and notifications dispatch only
// for freshly written rows — so the wall is also the notification dedup, and the pipeline stays
// at-least-once-safe without a second bookkeeping table.

import {
  type FanoutSignal,
  type Tx,
  notificationRepository,
  tenantSignalsRepository,
  watchlistRepository,
  withTenantTx,
} from "@leadwolf/db";

export interface FanoutScope {
  tenantId: string;
  workspaceId: string;
}

export interface FanoutResult {
  /** Signals offered to this workspace. */
  offered: number;
  /** tenant_signals rows actually written (0 for redeliveries and unbridged companies). */
  delivered: number;
  /** Notifications created for subscribed users. */
  notified: number;
}

/** Feed copy per family when the signal carries no headline. Organization facts only — never a person. */
const FAMILY_TITLES: Record<string, string> = {
  hiring: "Hiring change at a watched account",
  funding: "Funding event at a watched account",
  tech_change: "Technology change at a watched account",
  leadership: "Leadership change at a watched account",
  filing: "New filing from a watched account",
  other: "New signal on a watched account",
};

export async function fanoutSignalsToWorkspace(
  scope: FanoutScope,
  signals: readonly FanoutSignal[],
): Promise<FanoutResult> {
  if (signals.length === 0) return { offered: 0, delivered: 0, notified: 0 };
  return withTenantTx(scope, async (tx: Tx) => {
    let delivered = 0;
    let notified = 0;
    for (const signal of signals) {
      const written = await tenantSignalsRepository.projectCompanySignal(tx, signal);
      delivered += written.length;
      for (const row of written) {
        const subscribers = await watchlistRepository.subscribersFor(
          tx,
          row.accountId,
          signal.family,
        );
        for (const userId of subscribers) {
          await notificationRepository.create(tx, {
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            userId,
            type: "account_signal",
            title: signal.headline ?? FAMILY_TITLES[signal.family] ?? "Account signal",
            body: null,
            entityType: "account",
            entityId: row.accountId,
          });
          notified += 1;
        }
      }
    }
    return { offered: signals.length, delivered, notified };
  });
}
