// BulkRevealDialog.tsx — the bulk reveal confirmation modal on the foundation Dialog (mirrors RevealDialog;
// 04 §5, 07 §3). Before confirm it states what will run (N contacts, "you only pay for valid data") + the
// current balance — never a client-computed cost (cost is server-side). On confirm it runs useBulkReveal,
// shows progress, then a summary of the SERVER-reported charge + new balance, flips the revealed rows, and
// handles the out-of-credits stop inline (top-up link) so the flow has no dead ends. Toasts the outcome.
"use client";

import { Dialog, TpButton, useToast } from "@leadwolf/ui";
import Link from "next/link";
import { useEffect } from "react";
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

  // Reset hook state when the dialog opens so nothing stale shows from a prior run.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

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
          <p className={styles.revealMeta}>
            Balance: <strong>{balance === null ? "—" : balance.toLocaleString()}</strong> credits
          </p>
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
