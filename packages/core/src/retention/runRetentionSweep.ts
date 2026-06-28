// runRetentionSweep.ts — the per-tenant SHADOW retention pass (data-management backlog #6, phase 2; design
// 16-retention-engine-design.md §2/§5). Driven by the daily leader-locked dataRetentionSweep worker, once per
// ACTIVE tenant. CRITICAL SAFETY: this whole phase DELETES NOTHING. For each eligible class it only COUNTS the
// candidate rows (retentionScanRepository.countExpiredByClass — a SELECT count(*), no delete) and APPENDS a
// retention_runs evidence row with `deletedCount: 0`. Enforce-mode deletion is a later phase (phase 3).
//
// THE SAFETY ORDER (outermost first):
//   1. the per-tenant `retention_engine_enabled` flag — OFF (the fail-closed default) ⇒ record NOTHING, return.
//   2. per-class `mode` — `disabled` ⇒ skip the class.
//   3. per-class `ttlDays` — null (contacts, audit_log) ⇒ nothing ages, skip the class.
//   4. v1-only — a class whose deleter/count isn't wired yet (the v2 contact-cascade classes) ⇒ skip.
// Even past all four gates, SHADOW counts and records; it never deletes.
//
// Tx topology mirrors the other sweeps: the flag read + the policy read run under one withTenantTx (RLS exposes
// the global policy defs + this tenant's flag override); the COUNT is a separate OWNER read (cross-tenant system
// read, explicit tenant predicate — see retentionScanRepository); the run-audit append runs under withTenantTx
// (RLS pins tenant_id on insert). `now` is injectable for tests; the worker passes none → new Date().

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

export interface RetentionShadowSweepResult {
  tenantId: string;
  /** Was the per-tenant engine flag enabled? When false, NOTHING is read or recorded for the tenant. */
  enabled: boolean;
  /** Number of retention_runs rows appended (one per eligible v1 class). */
  classesRecorded: number;
  /** Sum of candidate counts across the recorded classes (the "would delete" total — shadow). */
  totalCandidates: number;
}

/**
 * Run the SHADOW retention pass for ONE tenant: gate on the per-tenant engine flag, then for each eligible v1
 * policy COUNT the candidate rows and append a retention_runs row (deletedCount ALWAYS 0). Deletes nothing.
 */
export async function runRetentionShadowSweep(input: {
  tenantId: string;
  now?: Date;
}): Promise<RetentionShadowSweepResult> {
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
    return { tenantId, enabled: false, classesRecorded: 0, totalCandidates: 0 };
  }

  // 2) COUNT candidates per eligible class on the OWNER connection (explicit tenant predicate; never deletes).
  //    Eligible = a v1 class (count wired) AND a finite ttlDays (null = nothing ages) AND mode != 'disabled'.
  const counted: Array<{ policy: RetentionPolicy; cutoff: Date; candidateCount: number }> = [];
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
    counted.push({ policy, cutoff, candidateCount });
    // SHADOW: this is WHAT WOULD DELETE — log it; delete nothing (deletedCount stays 0 below).
    console.info(
      `[retention][shadow] would delete ${candidateCount} ${policy.dataClass} rows (tenant ${tenantId})`,
    );
  }

  // 3) Append one immutable retention_runs evidence row per class under the tenant-scoped tx (RLS pins
  //    tenant_id on insert). deletedCount: 0 — shadow mode deletes nothing.
  const runFinishedAt = new Date();
  if (counted.length > 0) {
    await withTenantTx({ tenantId }, async (tx) => {
      for (const c of counted) {
        await retentionRunRepository.recordRun(tx, {
          tenantId,
          dataClass: c.policy.dataClass,
          mode: c.policy.mode,
          candidateCount: c.candidateCount,
          deletedCount: 0,
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
    classesRecorded: counted.length,
    totalCandidates: counted.reduce((sum, c) => sum + c.candidateCount, 0),
  };
}
