// runRetentionSweep.ts — the per-tenant retention pass (data-management backlog #6; design
// 16-retention-engine-design.md §2/§5). Driven by the daily leader-locked dataRetentionSweep worker, once per
// ACTIVE tenant. It handles BOTH modes: `shadow` COUNTS candidates and records evidence (deletes nothing, phase 2);
// `enforce` additionally PURGES the counted rows (phase 3). The first real deletion in the engine is DOUBLE-GATED
// and ships INERT:
//   • the per-tenant `retention_engine_enabled` flag defaults FALSE — off ⇒ record NOTHING, return;
//   • every class's policy.mode defaults `shadow` — a class purges ONLY when mode === 'enforce'.
// So with the shipped defaults NOTHING deletes until an operator deliberately flips a class to `enforce` on a
// flag-enabled tenant.
//
// THE SAFETY ORDER (outermost first):
//   1. the per-tenant `retention_engine_enabled` flag — OFF (the fail-closed default) ⇒ record NOTHING, return.
//   2. per-class `mode` — `disabled` ⇒ skip the class entirely.
//   3. per-class `ttlDays` — null (contacts, audit_log) ⇒ nothing ages, skip the class.
//   4. v1-only — a class whose count/deleter isn't wired yet (the v2 contact-cascade classes) ⇒ skip.
// Past all four gates: `shadow` counts + records (deletedCount 0); ONLY `enforce` deletes (batched, owner
// connection, explicit tenant predicate — see retentionScanRepository).
//
// Tx topology mirrors the other sweeps: the flag read + the policy read run under one withTenantTx (RLS exposes
// the global policy defs + this tenant's flag override); the COUNT and the (enforce-only) DELETE are separate OWNER
// operations (cross-tenant system ops, explicit tenant predicate — see retentionScanRepository); the run-audit
// append runs under withTenantTx (RLS pins tenant_id on insert). `now` is injectable for tests; the worker passes
// none → new Date().
//
// AUDIT: the immutable `retention_runs` row (mode + candidateCount + deletedCount + cutoff + window) IS the
// auditable evidence. We deliberately do NOT also write an audit_log entry: `audit_log` is workspace-scoped and its
// `auditAction` vocabulary is a closed enum (no `retention.*` action), whereas a retention sweep is tenant-scoped
// and spans every workspace of the tenant — so an audit_log row does not fit cleanly. retention_runs is the record.

import {
  isRetentionV1Class,
  retentionPolicyRepository,
  retentionRunRepository,
  retentionScanRepository,
  withTenantTx,
} from "@leadwolf/db";
import { RETENTION_ENGINE_FLAG_KEY, type RetentionPolicy } from "@leadwolf/types";
import { isFlagEnabledForTenant } from "../featureFlags/flagsForTenant.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionSweepResult {
  tenantId: string;
  /** Was the per-tenant engine flag enabled? When false, NOTHING is read or recorded for the tenant. */
  enabled: boolean;
  /** Number of retention_runs rows appended (one per eligible v1 class). */
  classesRecorded: number;
  /** Sum of candidate counts across the recorded classes (the "would delete" total). */
  totalCandidates: number;
  /** Sum of rows actually deleted across the recorded classes (0 unless a class was in `enforce` mode). */
  totalDeleted: number;
}

/**
 * Run the retention pass for ONE tenant: gate on the per-tenant engine flag, then for each eligible v1 policy COUNT
 * the candidate rows, PURGE them only when the class is in `enforce` mode (the double-gate), and append a
 * retention_runs row (deletedCount = rows purged, always 0 in shadow). Deletes nothing unless a class is `enforce`.
 */
export async function runRetentionSweepForTenant(input: {
  tenantId: string;
  now?: Date;
}): Promise<RetentionSweepResult> {
  const { tenantId } = input;
  const runStartedAt = input.now ?? new Date();

  // 1) The OUTERMOST gate: the per-tenant engine flag (fail-closed default OFF). Off ⇒ record NOTHING and return.
  //    Read the flag + the global policies under one tenant-scoped tx (RLS exposes both; flagsForTenant.ts).
  const gate = await withTenantTx({ tenantId }, async (tx) => {
    const enabled = await isFlagEnabledForTenant(tx, tenantId, RETENTION_ENGINE_FLAG_KEY);
    if (!enabled) return { enabled: false as const, policies: [] as RetentionPolicy[] };
    const policies = await retentionPolicyRepository.listPolicies(tx);
    return { enabled: true as const, policies };
  });
  if (!gate.enabled) {
    return { tenantId, enabled: false, classesRecorded: 0, totalCandidates: 0, totalDeleted: 0 };
  }

  // 2) Per eligible class: COUNT candidates (always), then — ONLY in enforce mode — PURGE them. Both run on the
  //    OWNER connection with an explicit tenant predicate (never relies on RLS).
  //    Eligible = a v1 class (count/deleter wired) AND a finite ttlDays (null = nothing ages) AND mode != 'disabled'.
  const processed: Array<{
    policy: RetentionPolicy;
    cutoff: Date;
    candidateCount: number;
    deletedCount: number;
  }> = [];
  for (const policy of gate.policies) {
    if (!isRetentionV1Class(policy.dataClass)) continue; // v2 / not-yet-wired class — skip
    const { ttlDays } = policy;
    if (ttlDays === null || policy.mode === "disabled") continue; // nothing ages / engine ignores the class
    const cutoff = new Date(runStartedAt.getTime() - ttlDays * DAY_MS);
    const candidateCount = await retentionScanRepository.countExpiredByClass({
      dataClass: policy.dataClass,
      tenantId,
      cutoff,
    });

    // ENFORCE (the double-gated, opt-in delete): the per-tenant flag already passed AND this class is `enforce`
    // ⇒ purge the counted rows (batched, owner connection, same explicit tenant predicate). Any other mode
    // (`shadow`) deletes NOTHING — deletedCount stays 0, exactly as phase 2.
    let deletedCount = 0;
    if (policy.mode === "enforce") {
      deletedCount = await retentionScanRepository.deleteExpiredByClass({
        dataClass: policy.dataClass,
        tenantId,
        cutoff,
      });
      console.info(
        `[retention][enforce] deleted ${deletedCount} ${policy.dataClass} rows (tenant ${tenantId})`,
      );
    } else {
      // SHADOW: this is WHAT WOULD DELETE — log it; delete nothing (deletedCount stays 0).
      console.info(
        `[retention][shadow] would delete ${candidateCount} ${policy.dataClass} rows (tenant ${tenantId})`,
      );
    }
    processed.push({ policy, cutoff, candidateCount, deletedCount });
  }

  // 3) Append one immutable retention_runs evidence row per class under the tenant-scoped tx (RLS pins tenant_id
  //    on insert). deletedCount reflects the real purge (0 in shadow) — the run row IS the auditable record.
  const runFinishedAt = new Date();
  if (processed.length > 0) {
    await withTenantTx({ tenantId }, async (tx) => {
      for (const c of processed) {
        await retentionRunRepository.recordRun(tx, {
          tenantId,
          dataClass: c.policy.dataClass,
          mode: c.policy.mode,
          candidateCount: c.candidateCount,
          deletedCount: c.deletedCount,
          cutoff: c.cutoff,
          runStartedAt,
          runFinishedAt,
        });
      }
    });
  }

  return {
    tenantId,
    enabled: true,
    classesRecorded: processed.length,
    totalCandidates: processed.reduce((sum, c) => sum + c.candidateCount, 0),
    totalDeleted: processed.reduce((sum, c) => sum + c.deletedCount, 0),
  };
}
