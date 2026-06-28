// reverifyContacts.ts — the freshness re-verification loop (ADR-0025, 22 §3/§4; data-management 09 §5 / 13 §6).
// runImport/reveal grade a channel AS it lands; B2B data then decays, so this RE-grades REVEALED (in-use), live
// contacts whose last_verified_at is past the freshness SLA — keyset-paged, per workspace, off the request
// thread. It reuses THE SAME verifiers the reveal path wires (defaultEmailVerifier → Reacher when configured;
// defaultPhoneVerifier → Twilio Lookup when configured) — no second grading path (DM1). The freshness clock
// (contacts.last_verified_at) IS the watermark: a re-verified row's last_verified_at resets to now, so it leaves
// the stale set until it decays again. Each completed run is ALSO recorded in the verification_jobs audit ledger
// (PLAN_06) for observability — best-effort, never fails the run.
//
// In-use gate = REVEALED contacts only (the workspace paid for them → they are the ones worth re-verifying),
// which bounds verifier spend. Tx topology mirrors runMasterBackfill: read a batch under withTenantTx (RLS),
// verify OUTSIDE any tx (network I/O — never inside a transaction, 14 §3.5), then write the batch under
// withTenantTx. SAFE NO-OP when no real verifier is configured (passThrough): re-grading nothing must NOT reset
// the freshness clock and falsely mark records fresh, so the loop returns early.

import {
  type ContactWriteValues,
  contactRepository,
  verificationJobRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  type EmailStatus,
  FRESHNESS_SLA_DAYS,
  type PhoneLineType,
  type PhoneStatus,
  type ReverificationRun,
  reverifyCutoff,
} from "@leadwolf/types";
import { isFlagEnabledForTenant } from "../featureFlags/flagsForTenant.ts";
import { decryptPii } from "../import/encryptPii.ts";
import { type EmailVerifierPort, passThroughVerifier } from "./emailVerifier.ts";
import { formatOnlyPhoneVerifier, type PhoneVerifierPort } from "./phoneVerifier.ts";
import { defaultEmailVerifier } from "./reacherVerifier.ts";
import { defaultPhoneVerifier } from "./twilioPhoneVerifier.ts";

/** The per-tenant feature flag (ADR-0011) that gates re-verification rollout — the plans mandate per-tenant
 *  flags + shadow-before-cutover. Unknown/undefined → OFF (fail-closed, opt-in): the loop ships dark and is
 *  enabled per tenant (or globally) by a platform admin once REACHER is also configured. */
export const REVERIFICATION_FLAG_KEY = "data_health.reverification";

export interface ReverificationResult {
  /** Rows scanned (revealed + past-SLA) across every batch this run. */
  scanned: number;
  /** Of those, the rows whose channels were re-graded + last_verified_at reset this run. */
  reverified: number;
  /** Rows whose verify OR write threw (transient/unexpected) — left for a later sweep (their clock not reset). */
  errored: number;
}

/** One row's freshly-graded channel state, ready to stamp under the overlay tx. */
interface ReverifiedRow {
  contactId: string;
  emailStatus: EmailStatus;
  phoneStatus: PhoneStatus | null;
  phoneLineType: PhoneLineType | null;
}

/**
 * Re-verify the REVEALED, past-SLA contacts of ONE workspace, resetting their freshness clock. Walks keyset-paged
 * bounded batches until a short/empty page; returns the scanned / reverified / errored tally. `opts.verifier` is
 * injectable (the worker / tests pass one); it defaults to the configured verifier (Reacher when set, else the
 * pass-through → early no-op). `opts.now` is injectable for tests.
 */
export async function runReverification(
  scope: { tenantId: string; workspaceId: string },
  opts?: {
    batchSize?: number;
    verifier?: EmailVerifierPort;
    phoneVerifier?: PhoneVerifierPort;
    now?: Date;
  },
): Promise<ReverificationResult> {
  const verifier = opts?.verifier ?? defaultEmailVerifier();
  const phoneVerifier = opts?.phoneVerifier ?? defaultPhoneVerifier();
  // No real verifier wired (email pass-through AND phone format-only) → re-grading nothing; do NOT reset any
  // freshness clock (that would falsely mark records fresh). The sweep also guards on this; defensive 2nd line.
  if (
    verifier.name === passThroughVerifier.name &&
    phoneVerifier.name === formatOnlyPhoneVerifier.name
  ) {
    return { scanned: 0, reverified: 0, errored: 0 };
  }

  // Per-tenant rollout gate (ADR-0011): re-verification runs only when the data_health.reverification flag is
  // enabled for this tenant (unknown flag → off, opt-in). Read under a tenant-scoped tx, like every other gate.
  const enabled = await withTenantTx(
    { tenantId: scope.tenantId, workspaceId: scope.workspaceId },
    (tx) => isFlagEnabledForTenant(tx, scope.tenantId, REVERIFICATION_FLAG_KEY),
  );
  if (!enabled) return { scanned: 0, reverified: 0, errored: 0 };

  const limit = opts?.batchSize ?? 500;
  const now = opts?.now ?? new Date();
  const cutoff = reverifyCutoff(now, FRESHNESS_SLA_DAYS.email);
  let cursor: string | null = null;
  let scanned = 0;
  let reverified = 0;
  let errored = 0;

  for (;;) {
    // 1) Read one keyset-paged batch of revealed, past-SLA contacts under the workspace-scoped overlay role.
    const batch = await withTenantTx(scope, (tx) =>
      contactRepository.findStaleRevealedForReverify(tx, cutoff, cursor, limit),
    );
    if (batch.length === 0) break;
    scanned += batch.length;

    // 2) Verify OUTSIDE any transaction (network I/O — 14 §3.5). Decrypt only to call the verifier; plaintext
    //    stays local. A row with no PII is skipped (nothing to verify → don't reset its clock). One bad row is
    //    non-fatal: skip it (its clock is not reset, so a later sweep retries it).
    const graded: ReverifiedRow[] = [];
    for (const row of batch) {
      try {
        const email = row.emailEnc ? decryptPii(row.emailEnc) : null;
        const phone = row.phoneEnc ? decryptPii(row.phoneEnc) : null;
        if (!email && !phone) continue; // degenerate revealed row with no PII — leave its clock untouched
        const emailStatus = email
          ? await verifier.verify(email, row.emailStatus as EmailStatus)
          : (row.emailStatus as EmailStatus);
        const phoneResult = phone
          ? await phoneVerifier.verify(phone, row.phoneStatus as PhoneStatus | null)
          : null;
        const phoneStatus = phoneResult?.status ?? (row.phoneStatus as PhoneStatus | null);
        const phoneLineType = phoneResult?.lineType ?? null;
        graded.push({ contactId: row.id, emailStatus, phoneStatus, phoneLineType });
      } catch (err) {
        errored += 1;
        console.error("[reverify] verify failed; leaving row for a later sweep", row.id, err);
      }
    }

    // 3) Stamp the freshly-graded batch under ONE withTenantTx (RLS-scoped). Resetting last_verified_at takes the
    //    row out of the stale set. A per-row write failure is non-fatal — skip it (retried by a later sweep).
    await withTenantTx(scope, async (tx) => {
      for (const g of graded) {
        try {
          const values: Partial<ContactWriteValues> = {
            emailStatus: g.emailStatus,
            phoneStatus: g.phoneStatus,
            ...(g.phoneLineType ? { phoneLineType: g.phoneLineType } : {}),
            lastVerifiedAt: now,
          };
          await contactRepository.update(tx, g.contactId, values);
          reverified += 1;
        } catch (err) {
          errored += 1;
          console.error("[reverify] stamp failed; leaving row for a later sweep", g.contactId, err);
        }
      }
    });

    // 4) Advance the keyset cursor; a short page means we reached the end of the stale set.
    cursor = batch[batch.length - 1]!.id;
    if (batch.length < limit) break;
  }

  // Record the completed run in the audit ledger (PLAN_06) — best-effort: a ledger write must NEVER fail the run
  // (the tally is already computed + the freshness clocks stamped). Workspace-scoped like every write.
  try {
    await withTenantTx(scope, (tx) =>
      verificationJobRepository.record(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        startedAt: now,
        finishedAt: new Date(),
        scanned,
        reverified,
        errored,
      }),
    );
  } catch (err) {
    console.error("[reverify] audit-ledger write failed (non-fatal)", scope.workspaceId, err);
  }

  return { scanned, reverified, errored };
}

/** Recent re-verification runs for a workspace, newest first (the Data Health "re-verification activity" read).
 *  Reads the verification_jobs ledger written by runReverification (PLAN_06). */
export async function recentReverificationRuns(
  scope: { tenantId: string; workspaceId: string },
  limit = 50,
): Promise<ReverificationRun[]> {
  const rows = await withTenantTx(scope, (tx) => verificationJobRepository.listRecent(tx, limit));
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt.toISOString(),
    scanned: r.scanned,
    reverified: r.reverified,
    errored: r.errored,
    createdAt: r.createdAt.toISOString(),
  }));
}
