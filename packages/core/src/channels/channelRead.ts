// channelRead.ts — the S-CH4 read-cutover COMPOSED gate evaluator (import-and-data-model-redesign 05
// §Implementation Steps / §5; 15 §M-SEQ Phase 3). This is the ONE decision every cut-over read surface
// consults before resolving channel data from the `contact_emails`/`contact_phones` child tables instead of
// the flat primary-cache columns.
//
// COMPOSITION (fail-closed at every layer; read IMPLIES dual-write — 05 §5's ordering: cutting reads over
// to child rows that no writer maintains would serve stale truth, so the read gate can never evaluate ON
// while the dual-write gate is off):
//   effective read-from-child =
//        env.CHANNEL_READ_FROM_CHILD          (S-CH4 env kill-switch — THE NAME DOC 05's S-CH4 row pins)
//    AND isChannelDualWriteEnabled(...)       (the FULL S-CH2 dual gate: CHANNEL_DUAL_WRITE env
//                                              + `channels_dual_write` per-tenant flag)
//    AND the `channels_read` per-tenant flag  (seeded off in 0060; unknown/unreadable ⇒ off)
//
// While the ENV layer is off this performs ZERO queries, so a gate-off read is cost-identical as well as
// byte-identical (the T-CH-parity discipline extended to reads). Flipping any layer off is the instant
// §R-P3 read rollback: reads return to the flat cache (still dual-write-maintained); secondaries merely go
// invisible again, nothing is lost. FLIP PRECONDITIONS (05 §Rollout / 15 §T-P3): parity itests green in CI
// + backfill completeness = 0 (`countContactsMissingChannelProjection`) + drift = 0.

import { env } from "@leadwolf/config";
import { type Tx, withTenantTx } from "@leadwolf/db";
import { CHANNELS_READ_FLAG_KEY } from "@leadwolf/types";
import { isFlagEnabledForTenant } from "../featureFlags/flagsForTenant.ts";
import { isChannelDualWriteEnabled } from "./channelDualWrite.ts";

/** Evaluate the S-CH4 composed read gate INSIDE an existing tenant tx (reveal reads, dynamic-list member
 *  resolution, chunk-merge dedup, select-all resolution). Env layer off ⇒ false with zero queries. A
 *  flag-read failure propagates with the caller's tx (never catch inside a possibly-aborted tx — the
 *  isChannelDualWriteEnabled posture). */
export async function isChannelReadFromChildEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  if (!env.CHANNEL_READ_FROM_CHILD) return false;
  // Read implies dual-write (05 §5): the S-CH2 dual gate must evaluate ON for this tenant first.
  if (!(await isChannelDualWriteEnabled(tx, tenantId))) return false;
  return isFlagEnabledForTenant(tx, tenantId, CHANNELS_READ_FLAG_KEY);
}

/** Evaluate the composed read gate ONCE per run/request in its own scoped tx (the import engine's per-run
 *  evaluation, the search port build, the export). FAIL-CLOSED on error: a flag-read hiccup falls back to
 *  the shipped flat-column read path (which the permanent primary cache keeps correct for primaries),
 *  never fails the caller. */
export async function channelReadFromChildEnabledForScope(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<boolean> {
  if (!env.CHANNEL_READ_FROM_CHILD) return false;
  try {
    return await withTenantTx(scope, (tx) => isChannelReadFromChildEnabled(tx, scope.tenantId));
  } catch (err) {
    console.error("[channels] read-cutover flag read failed; falling back to flat reads", err);
    return false;
  }
}
