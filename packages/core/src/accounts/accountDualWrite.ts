// accountDualWrite.ts — the S-A2 dual-gate evaluator for the account-domain dual-write
// (import-and-data-model-redesign 06 §1/§Rollout; the T-P4 parity gate is the flag-off proof). The direct
// sibling of channelDualWrite.ts's gate half applied to accounts.
//
// THE GATE (dual, fail-closed — the channelDualWrite / importV2Gate precedent): effective dual-write =
//   env.ACCOUNT_DOMAINS_DUAL_WRITE (global kill-switch, explicit-"true"-only)
//   AND the per-tenant `account_domains_dual_write` feature flag (seeded off in 0062).
// While the ENV layer is off this performs ZERO queries, so a gate-off account write is cost-identical as well
// as byte-identical. The flag layer is evaluated IN-TX (works identically in apps/api and apps/workers — both
// reach writers through withTenantTx; no job-payload carry, so a mid-run flag flip takes effect on the next
// evaluation). Unknown/unreadable flag ⇒ off (fail-closed via evaluateFlag).
//
// 06 names NO dual-write flag (only the S-A6 read-cutover gate); this pair (env + `account_domains_dual_write`)
// is MINTED for S-A2, mirroring the channel train's CHANNEL_DUAL_WRITE + `channels_dual_write` — recorded as a
// doc-16 drift row.

import { env } from "@leadwolf/config";
import { type Tx, withTenantTx } from "@leadwolf/db";
import { ACCOUNT_DOMAINS_DUAL_WRITE_FLAG_KEY } from "@leadwolf/types";
import { isFlagEnabledForTenant } from "../featureFlags/flagsForTenant.ts";

/** Evaluate the S-A2 dual gate INSIDE an existing tenant tx (the account backfill's batch-boundary abort +
 *  any in-tx account writer). Env layer off ⇒ false with zero queries. A flag-read failure propagates with the
 *  caller's tx (never catch inside an aborted tx). */
export async function isAccountDomainsDualWriteEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  if (!env.ACCOUNT_DOMAINS_DUAL_WRITE) return false;
  return isFlagEnabledForTenant(tx, tenantId, ACCOUNT_DOMAINS_DUAL_WRITE_FLAG_KEY);
}

/** Evaluate the dual gate ONCE per run in its own scoped tx (the import engine's per-run evaluation — a
 *  10k-row import must not re-read the flag per row). FAIL-CLOSED on error: a flag-read hiccup falls back to
 *  the shipped flat-only path (dual-write is additive; the S-A1 backfill closes any tail), never fails the run.
 *  never fails the run (the channelDualWrite precedent). */
export async function accountDomainsDualWriteEnabledForScope(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<boolean> {
  if (!env.ACCOUNT_DOMAINS_DUAL_WRITE) return false;
  try {
    return await withTenantTx(scope, (tx) =>
      isFlagEnabledForTenant(tx, scope.tenantId, ACCOUNT_DOMAINS_DUAL_WRITE_FLAG_KEY),
    );
  } catch (err) {
    console.error("[accounts] dual-write flag read failed; falling back to flat-only", err);
    return false;
  }
}
