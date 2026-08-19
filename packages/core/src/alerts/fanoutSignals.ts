// fanoutSignals.ts — the per-workspace DELIVERY step of the signal fan-out (market-intelligence MI-S6;
// docs/planning/market-intelligence/06-architecture.md §2/§3). Outcomes: [S-13][S-09].
//
// The sweep (apps/workers signalFanout) does the census on the owner connection; THIS function is the
// tenant half: one withTenantTx per workspace, RLS ENFORCING, projecting each Layer-0 company signal
// onto the workspace's bridged accounts. It re-decides nothing — which signals exist and which
// workspaces care were both decided upstream; here a redelivery collapses on the (workspace, signal)
// unique wall, which is what makes the whole pipeline at-least-once-safe.

import { type FanoutSignal, type Tx, tenantSignalsRepository, withTenantTx } from "@leadwolf/db";

export interface FanoutScope {
  tenantId: string;
  workspaceId: string;
}

export interface FanoutResult {
  /** Signals offered to this workspace. */
  offered: number;
  /** tenant_signals rows actually written (0 for redeliveries and unbridged companies). */
  delivered: number;
}

export async function fanoutSignalsToWorkspace(
  scope: FanoutScope,
  signals: readonly FanoutSignal[],
): Promise<FanoutResult> {
  if (signals.length === 0) return { offered: 0, delivered: 0 };
  return withTenantTx(scope, async (tx: Tx) => {
    let delivered = 0;
    for (const signal of signals) {
      delivered += await tenantSignalsRepository.projectCompanySignal(tx, signal);
    }
    return { offered: signals.length, delivered };
  });
}
