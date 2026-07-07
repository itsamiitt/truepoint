// accountRead.ts — the S-A6 account READ-CUTOVER COMPOSED gate evaluator (import-and-data-model-redesign 06
// §6/§API / §Rollout; 15 §M-SEQ seq 59). The direct sibling of channelRead.ts's S-CH4 gate applied to accounts.
// This is the ONE decision every account read surface consults before resolving from the child tables
// (`account_domains`/`account_locations`) instead of the flat primary-value caches — AND the gate the import
// company-match ladder consults before activating rung C2 (any-live-secondary-domain exact — 06 §5).
//
// COMPOSITION (fail-closed at every layer; read IMPLIES dual-write — 06 §4's ordering, the S-CH4 precedent:
// cutting reads over to child rows that no writer maintains would serve stale truth, so the read gate can never
// evaluate ON while the dual-write gate is off):
//   effective read-from-child =
//        env.ACCOUNT_READ_FROM_CHILD          (S-A6 env kill-switch — the pair minted for S-A6, doc 16)
//    AND isAccountDomainsDualWriteEnabled(...) (the FULL S-A2 dual gate: ACCOUNT_DOMAINS_DUAL_WRITE env
//                                               + `account_domains_dual_write` per-tenant flag)
//    AND the `account_read_from_child` flag    (seeded off in 0064; unknown/unreadable ⇒ off)
//
// While the ENV layer is off this performs ZERO queries, so a gate-off read/import is cost-identical as well as
// byte-identical (the T-P4 parity discipline extended to reads). Flipping any layer off is the instant §R-P4
// read rollback: reads return to the flat cache (still dual-write-maintained); rung C2 goes dark and secondaries
// go invisible again, nothing is lost. FLIP PRECONDITION (07 §8 edge / 15 §M-SEQ seq 55):
// countAccountsMissingDomainChild = 0 (the S-A1 backfill re-run has converged) so every primary domain has a
// live account_domains row.

import { env } from "@leadwolf/config";
import { type Tx, withTenantTx } from "@leadwolf/db";
import { ACCOUNT_READ_FROM_CHILD_FLAG_KEY } from "@leadwolf/types";
import { isFlagEnabledForTenant } from "../featureFlags/flagsForTenant.ts";
import { isAccountDomainsDualWriteEnabled } from "./accountDualWrite.ts";

/** Evaluate the S-A6 composed read gate INSIDE an existing tenant tx. Env layer off ⇒ false with zero queries.
 *  A flag-read failure propagates with the caller's tx (never catch inside a possibly-aborted tx — the
 *  isAccountDomainsDualWriteEnabled posture). */
export async function isAccountReadFromChildEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  if (!env.ACCOUNT_READ_FROM_CHILD) return false;
  // Read implies dual-write (06 §4): the S-A2 dual gate must evaluate ON for this tenant first.
  if (!(await isAccountDomainsDualWriteEnabled(tx, tenantId))) return false;
  return isFlagEnabledForTenant(tx, tenantId, ACCOUNT_READ_FROM_CHILD_FLAG_KEY);
}

/** Evaluate the composed read gate ONCE per run/request in its own scoped tx (the import engine's per-run
 *  evaluation, an account-detail read). FAIL-CLOSED on error: a flag-read hiccup falls back to the shipped
 *  flat-column read path (which the permanent primary cache keeps correct for primaries), never fails the
 *  caller — the channelReadFromChildEnabledForScope precedent. */
export async function accountReadFromChildEnabledForScope(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<boolean> {
  if (!env.ACCOUNT_READ_FROM_CHILD) return false;
  try {
    return await withTenantTx(scope, (tx) => isAccountReadFromChildEnabled(tx, scope.tenantId));
  } catch (err) {
    console.error("[accounts] read-cutover flag read failed; falling back to flat reads", err);
    return false;
  }
}
