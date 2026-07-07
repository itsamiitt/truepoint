// scheduledImportGate.ts — the P5 scheduled-imports DUAL-GATE evaluator (import-and-data-model-redesign 08 §9;
// 14 Phase 5). Mirrors channelDualWrite.ts's two evaluators EXACTLY — one in-tx, one fail-closed-for-scope —
// over the SCHEDULED_IMPORTS_ENABLED env kill-switch AND the per-tenant `scheduled_imports_enabled` feature
// flag (seeded off in migration 0063). The GATE IS FAIL-CLOSED at every layer:
//   effective = env.SCHEDULED_IMPORTS_ENABLED (global kill-switch, explicit-"true"-only)
//               AND the per-tenant `scheduled_imports_enabled` flag (unknown/unreadable ⇒ off).
// While the ENV layer is off this performs ZERO queries, so a gate-off world reads/writes nothing (the sweep
// is never even constructed in register.ts, and the api verbs 404). The FLAG layer is evaluated IN-TX so it
// works identically in apps/api (the CRUD verbs) and apps/workers (the leader-locked sweep) — both reach the
// DB through withTenantTx; a mid-flight flag flip takes effect on the next evaluation (no job-payload carry).
//
// USAGE. The worker SWEEP re-checks `isScheduledImportsEnabled(tx, tenantId)` under the row lock BEFORE firing
// a due schedule — a tenant flipped off SKIPS (the schedule is neither disabled nor advanced; a re-flip
// resumes it). The api VERBS gate-on-404 via `scheduledImportsEnabledForScope(scope)` (the S-I8 no-existence-
// oracle posture: gate-off ⇒ every verb 404s, so the endpoint is invisible until the tenant is enabled).

import { env } from "@leadwolf/config";
import { type Tx, withTenantTx } from "@leadwolf/db";
import { SCHEDULED_IMPORTS_FLAG_KEY } from "@leadwolf/types";
import { isFlagEnabledForTenant } from "../featureFlags/flagsForTenant.ts";

/** Evaluate the P5 dual gate INSIDE an existing tenant tx (the worker sweep's under-lock re-check). Env layer
 *  off ⇒ false with zero queries. A flag-read failure propagates with the caller's tx (never catch inside an
 *  aborted tx — the sweep's per-schedule tenant tx owns the fate of this read). */
export async function isScheduledImportsEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  if (!env.SCHEDULED_IMPORTS_ENABLED) return false;
  return isFlagEnabledForTenant(tx, tenantId, SCHEDULED_IMPORTS_FLAG_KEY);
}

/** Evaluate the P5 dual gate ONCE in its own scoped tx (the api verbs' gate-on-404 check). FAIL-CLOSED on
 *  error: a flag-read hiccup reads as OFF (the verb 404s) rather than leaking an existence oracle or half-
 *  admitting a write — the tightest posture, since a scheduled import is durable automation. */
export async function scheduledImportsEnabledForScope(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<boolean> {
  if (!env.SCHEDULED_IMPORTS_ENABLED) return false;
  try {
    return await withTenantTx(scope, (tx) =>
      isFlagEnabledForTenant(tx, scope.tenantId, SCHEDULED_IMPORTS_FLAG_KEY),
    );
  } catch (err) {
    console.error("[scheduled-imports] flag read failed; treating as disabled (fail-closed)", err);
    return false;
  }
}
