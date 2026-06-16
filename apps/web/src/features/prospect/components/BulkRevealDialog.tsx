// BulkRevealDialog.tsx — the bulk reveal confirmation modal (mirrors RevealDialog; 04 §5, 07 §3). Centered
// over a scrim; Esc/scrim/Cancel dismiss (disabled mid-run). Before confirm it states what will run (N
// contacts, "you only pay for valid data") + the current balance — it never shows a client-computed cost
// (cost is server-side). On confirm it runs useBulkReveal, shows progress, then a summary of the
// SERVER-reported charge + new balance, flips the revealed rows, and handles the out-of-credits stop inline
// (top-up link) so the flow has no dead ends.
"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useBulkReveal } from "../hooks/useBulkReveal";

export function BulkRevealDialog({
  contactIds,
  balance,
  onClose,
  onRevealed,
}: {
  /** Selected ids that can actually be revealed (already filtered to hasEmail && !isRevealed). */
  contactIds: string[];
  /** Current tenant balance for the pre-spend display (null while loading/unavailable). */
  balance: number | null;
  onClose: () => void;
  /** Fired with every revealed id so the parent can flip those rows + clear the selection. */
  onRevealed: (revealedIds: string[]) => void;
}) {
  const { progress, summary, busy, run, reset } = useBulkReveal();
  const count = contactIds.length;

  // Esc closes (keyboard-first; 04 §7) — but not mid-run, so a drain isn't abandoned half-charged-looking.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // Reset hook state when the dialog mounts so nothing stale shows from a prior run.
  useEffect(() => {
    reset();
  }, [reset]);

  async function onConfirm(): Promise<void> {
    const res = await run(contactIds);
    if (res.revealedIds.length > 0) onRevealed(res.revealedIds);
  }

  return (
    <div className="tp-scrim">
      {/* Backdrop as a button so click + keyboard both dismiss it (a11y); disabled mid-run. */}
      <button
        className="tp-scrim-backdrop"
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        disabled={busy}
      />
      <dialog className="tp-dialog" open aria-labelledby="tp-bulk-reveal-title">
        <h2 className="tp-dialog-title" id="tp-bulk-reveal-title">
          Reveal {count} contact{count === 1 ? "" : "s"}
        </h2>

        {!summary && (
          <>
            <p className="tp-dialog-note">
              Reveals the email for {count} selected contact{count === 1 ? "" : "s"}. Spends tenant
              credits; you only pay for valid data. Re-revealing in this workspace is free.
            </p>
            <p className="tp-dialog-sub">
              Balance:{" "}
              <strong>{balance === null ? "—" : balance.toLocaleString()}</strong> credits
            </p>
            {busy && progress && (
              <p className="app-muted">
                Revealing… {progress.done} of {progress.total}
              </p>
            )}
            <div className="tp-dialog-actions">
              <button className="tp-btn-ghost" type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="app-button"
                type="button"
                onClick={() => void onConfirm()}
                disabled={busy || count === 0}
              >
                {busy ? "Revealing…" : `Reveal ${count}`}
              </button>
            </div>
          </>
        )}

        {summary && (
          <>
            <p className="tp-reveal-meta">
              Revealed <strong>{summary.revealedIds.length}</strong> of {count}. Charged{" "}
              {summary.totalCharged} credit{summary.totalCharged === 1 ? "" : "s"}.{" "}
              {summary.balanceAfter !== null && (
                <>
                  Balance: <strong>{summary.balanceAfter.toLocaleString()}</strong> credits.
                </>
              )}
            </p>
            {summary.suppressedCount > 0 && (
              <p className="tp-dialog-note tp-muted-quiet">
                Skipped {summary.suppressedCount} on a do-not-contact list.
              </p>
            )}
            {summary.failedCount > 0 && (
              <p className="lw-error">
                {summary.failedCount} could not be revealed — try those again later.
              </p>
            )}
            {summary.stoppedForCredits && (
              <div className="tp-inline-alert">
                <p className="tp-inline-alert-msg">
                  Ran out of credits before finishing — top up to reveal the rest.
                </p>
                <Link className="tp-link-strong" href="/settings/billing">
                  Top up credits →
                </Link>
              </div>
            )}
            <div className="tp-dialog-actions">
              <button className="app-button" type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
