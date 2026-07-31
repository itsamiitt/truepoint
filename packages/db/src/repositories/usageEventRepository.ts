// usageEventRepository.ts — the writer for `usage_event`, the outcome-metric substrate behind
// docs/strategy/08-architecture.md § Instrumentation and every Phase 1 acceptance criterion expressed as a
// time/likelihood/count.
//
// The append rides INSIDE the caller's existing transaction, deliberately. A metric written in its own
// transaction can be lost while the action it records commits — and a reveal that happened but was not
// counted makes the reveal-hit rate quietly wrong, which is the number Phase 1's kill criterion is judged on.
// Same reasoning as provenance events, one tier down in consequence.
//
// This does NOT replace contact_reveals, credit_ledger, provider_calls, ai_requests or activities. Those keep
// metering billing and interaction; this answers the product questions none of them can. A metric surface and
// a money surface should never be the same rows — if they were, a pricing change would silently rewrite
// history that a kill criterion depends on.
//
// RLS is workspace-scoped and FORCE (rls/usageEvents.sql), so this must run under withTenantTx: the GUC is
// what scopes the insert, and an unscoped call writes nothing rather than writing everywhere.

import type { Tx } from "../client.ts";
import { usageEvent } from "../schema/usageEvent.ts";

/** The closed set of metered actions — mirrors the CHECK in migration 0092. */
export type UsageAction =
  | "reveal"
  | "reveal_miss"
  | "search"
  | "export"
  | "verify"
  | "save"
  | "badge_impression"
  | "enrich";

export interface UsageEventInput {
  tenantId: string;
  workspaceId: string;
  userId?: string | null;
  action: UsageAction;
  subjectType?: "contact" | "account" | "person" | null;
  /** The record acted on. Absent on a miss — there is no record to point at. */
  subjectId?: string | null;
  /**
   * A keyed HMAC of what was looked for, for misses. NEVER a raw LinkedIn slug or email: a miss log holding
   * identifiers would be a shadow database of people we hold nothing about, which an opt-out cannot reach
   * because there is no record to suppress. Sharing the blind-index key space means a suppression check can
   * still MATCH it without this table ever holding the identifier.
   */
  subjectFingerprint?: Uint8Array | null;
  demandedFields?: string[] | null;
  quantity?: number;
  /** Which entitlement cap this counted against; null = unmetered. */
  entitlementKey?: string | null;
  /** PII-free by contract. Latency, outcome codes, reveal type — never field values. */
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export const usageEventRepository = {
  /**
   * Append one metered action. MUST run inside the caller's tenant transaction.
   *
   * Not idempotent, and deliberately so: two reveals ARE two events, and there is no natural key that could
   * tell a duplicate emission from a genuine repeat action. Callers emit exactly once, at the point the action
   * commits — which is why this takes a `Tx` rather than opening its own.
   */
  async append(tx: Tx, input: UsageEventInput): Promise<void> {
    await tx.insert(usageEvent).values({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      action: input.action,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      subjectFingerprint: input.subjectFingerprint ?? null,
      demandedFields: input.demandedFields ?? null,
      quantity: input.quantity ?? 1,
      entitlementKey: input.entitlementKey ?? null,
      metadata: input.metadata ?? {},
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    });
  },
};
