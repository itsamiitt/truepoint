// BulkRevealDialog.tsx — the bulk reveal confirmation modal on the foundation Dialog (mirrors RevealDialog;
// 04 §5, 07 §3). Before confirm it states what will run (N contacts, "you only pay for valid data") + the
// current balance — never a client-computed cost (cost is server-side). On confirm it runs useBulkReveal,
// shows progress, then a summary of the SERVER-reported charge + new balance, flips the revealed rows, and
// handles the out-of-credits stop inline (top-up link) so the flow has no dead ends. Toasts the outcome.
"use client";

import type { BulkSpendEstimate } from "@leadwolf/types";
import { Dialog, TpButton, useToast } from "@leadwolf/ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { bulkEstimate } from "../bulkActionsApi";
import { useBulkReveal } from "../hooks/useBulkReveal";
import styles from "../prospect.module.css";

export function BulkRevealDialog({
  contactIds,
  balance,
  open,
  onClose,
  onRevealed,
}: {
  /** Selected ids that can actually be revealed (already filtered to hasEmail && !isRevealed). */
  contactIds: string[];
  /** Current tenant balance for the pre-spend display (null while loading/unavailable). */
  balance: number | null;
  open: boolean;
  onClose: () => void;
  /** Fired with every revealed id so the parent can flip those rows + clear the selection. */
  onRevealed: (revealedIds: string[]) => void;
}) {
  const toast = useToast();
  const { progress, summary, busy, run, reset } = useBulkReveal();
  const count = contactIds.length;
  // The pre-flight credit ESTIMATE (list-plan D5 — show cost + post-spend balance BEFORE confirm). Fetched
  // server-side over the real selection; null while loading or if the estimate call failed (the flow still
  // works — we fall back to the "you only pay for valid data" copy + the current balance).
  const [estimate, setEstimate] = useState<BulkSpendEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);

  // Reset hook state when the dialog opens so nothing stale shows from a prior run, then fetch the estimate.
  useEffect(() => {
    if (!open) return;
    reset();
    setEstimate(null);
    if (contactIds.length === 0) return;
    setEstimating(true);
    bulkEstimate({ contactIds }, "reveal")
      .then(setEstimate)
      .catch(() => setEstimate(null))
      .finally(() => setEstimating(false));
  }, [open, reset, contactIds]);

  const insufficient = estimate?.balanceAfterMin != null && estimate.balanceAfterMin < 0;

  async function onConfirm(): Promise<void> {
    const res = await run(contactIds);
    if (res.revealedIds.length > 0) {
      onRevealed(res.revealedIds);
      toast.success(
        `Revealed ${res.revealedIds.length} contact${res.revealedIds.length === 1 ? "" : "s"}`,
        `Charged ${res.totalCharged} credit${res.totalCharged === 1 ? "" : "s"}.`,
      );
    }
  }

  // Esc/backdrop close is the Dialog's job; we only block dismissal mid-run by ignoring onClose while busy.
  const close = () => {
    if (!busy) onClose();
  };

  const footer = summary ? (
    <TpButton onClick={close}>Done</TpButton>
  ) : (
    <>
      <TpButton variant="ghost" onClick={close} disabled={busy}>
        Cancel
      </TpButton>
      <TpButton onClick={() => void onConfirm()} loading={busy} disabled={count === 0}>
        Reveal {count}
      </TpButton>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Reveal ${count} contact${count === 1 ? "" : "s"}`}
      footer={footer}
      maxWidth={440}
    >
      {!summary && (
        <>
          <p className={styles.dialogNote}>
            Reveals the email for {count} selected contact{count === 1 ? "" : "s"}. Spends tenant
            credits; you only pay for valid data. Re-revealing in this workspace is free.
          </p>
          {/* The pre-flight estimate (D5): the worst-case cost + the post-spend floor, BEFORE confirming. The
              actual charge is ≤ this — invalid/catch-all/unknown emails charge 0 (charge-only-valid). */}
          {estimate ? (
            <p className={styles.revealMeta}>
              Costs up to{" "}
              <strong>
                {estimate.projectedMaxCredits.toLocaleString()} credit
                {estimate.projectedMaxCredits === 1 ? "" : "s"}
              </strong>{" "}
              ({estimate.billableCount.toLocaleString()} billable
              {estimate.matchableCount > 0
                ? `, ${estimate.matchableCount.toLocaleString()} already owned`
                : ""}
              ). Balance{" "}
              <strong>{estimate.balance === null ? "—" : estimate.balance.toLocaleString()}</strong>{" "}
              → <strong>{estimate.balanceAfterMin?.toLocaleString() ?? "—"}</strong> after.
            </p>
          ) : (
            <p className={styles.revealMeta}>
              {estimating ? (
                "Estimating cost…"
              ) : (
                <>
                  Balance: <strong>{balance === null ? "—" : balance.toLocaleString()}</strong>{" "}
                  credits
                </>
              )}
            </p>
          )}
          {insufficient && (
            <div className={styles.inlineAlert}>
              <p className={styles.inlineAlertMsg}>
                Not enough credits to reveal all {estimate?.billableCount.toLocaleString()} — top
                up, or reveal fewer.
              </p>
              <Link className={styles.topupLink} href="/settings/billing">
                Top up credits →
              </Link>
            </div>
          )}
          {busy && progress && (
            <p className={styles.progress}>
              Revealing… {progress.done} of {progress.total}
            </p>
          )}
        </>
      )}

      {summary && (
        <>
          <p className={styles.revealMeta}>
            Revealed <strong>{summary.revealedIds.length}</strong> of {count}. Charged{" "}
            {summary.totalCharged} credit{summary.totalCharged === 1 ? "" : "s"}.{" "}
            {summary.balanceAfter !== null && (
              <>
                Balance: <strong>{summary.balanceAfter.toLocaleString()}</strong> credits.
              </>
            )}
          </p>
          {summary.suppressedCount > 0 && (
            <p className={styles.dialogNote}>
              Skipped {summary.suppressedCount} on a do-not-contact list.
            </p>
          )}
          {summary.failedCount > 0 && (
            <p className={styles.dialogNote}>
              {summary.failedCount} could not be revealed — try those again later.
            </p>
          )}
          {summary.stoppedForCredits && (
            <div className={styles.inlineAlert}>
              <p className={styles.inlineAlertMsg}>
                Ran out of credits before finishing — top up to reveal the rest.
              </p>
              <Link className={styles.topupLink} href="/settings/billing">
                Top up credits →
              </Link>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
