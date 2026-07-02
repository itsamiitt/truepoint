// emitRevealEvent.ts — a BEST-EFFORT domain-event append (its own tx) for the async bulk-reveal path's
// coalesced progress/credit events (ADR-0027 §10 / doc 20 §10: bulk emits coalesced, not one event per row).
// This is NOT the crash-safe in-tx append the single reveal uses — a missed bulk event only means a briefly
// stale progress bar / balance until the next poll or fetch, which is acceptable. No-op (and no DB call) while
// REALTIME_SSE_ENABLED is off, so nothing accumulates in the outbox; never throws.

import { env } from "@leadwolf/config";
import { type TenantScope, eventOutboxRepository, withTenantTx } from "@leadwolf/db";

type WsScope = TenantScope & { workspaceId: string };

export function realtimeEnabled(): boolean {
  return env.REALTIME_SSE_ENABLED;
}

export async function emitRevealEvent(
  scope: WsScope,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!env.REALTIME_SSE_ENABLED) return;
  try {
    await withTenantTx(scope, (tx) =>
      eventOutboxRepository.append(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        eventType,
        payload,
      }),
    );
  } catch {
    // best-effort — the balance/progress is authoritative server-side; a dropped event self-heals on refetch.
  }
}
