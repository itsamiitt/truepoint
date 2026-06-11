// RevealDialog.tsx — the reveal confirmation modal (04 §5 "Reveal interaction", 09 §3.2). Centered, one soft
// shadow over a scrim; Esc/scrim-click/Cancel dismiss. Before confirm it states the cost note ("you only pay
// for valid data"); on confirm it runs the reveal via useReveal, then shows the revealed email/phone inline
// + the new tenant balance. It handles the two money-loop failure modes inline — insufficient_credits (402)
// links to top-up, suppressed (403) shows the quiet DNC notice — so the flow has no dead ends (04 §5).
"use client";

import type { MaskedContact, RevealType } from "@leadwolf/types";
import Link from "next/link";
import { useEffect } from "react";
import { useReveal } from "../hooks/useReveal";
import { displayName } from "../types";

const REVEAL_LABELS: Record<RevealType, string> = {
  email: "email",
  phone: "phone",
  full_profile: "full profile",
};

export function RevealDialog({
  contact,
  revealType,
  onClose,
  onRevealed,
}: {
  contact: MaskedContact;
  revealType: RevealType;
  onClose: () => void;
  /** Fired after a successful reveal so the parent can flip the row to revealed. */
  onRevealed: (contactId: string) => void;
}) {
  const { result, failure, busy, run, reset } = useReveal();

  // Esc closes the dialog (keyboard-first; 04 §7). Bound while the dialog is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Reset the hook state when the target contact/type changes so nothing stale shows.
  useEffect(() => {
    reset();
  }, [reset]);

  async function onConfirm(): Promise<void> {
    const res = await run(contact.id, revealType);
    if (res) onRevealed(contact.id);
  }

  const insufficient = failure?.code === "insufficient_credits";
  const suppressed = failure?.code === "suppressed";

  return (
    <div className="tp-scrim">
      {/* Backdrop as a button so click + keyboard both dismiss it (a11y) without a redundant role. */}
      <button
        className="tp-scrim-backdrop"
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
      />
      <dialog className="tp-dialog" open aria-labelledby="tp-reveal-title">
        <h2 className="tp-dialog-title" id="tp-reveal-title">
          Reveal {REVEAL_LABELS[revealType]}
        </h2>
        <p className="tp-dialog-sub">{displayName(contact)}</p>

        {!result && !suppressed && (
          <>
            <p className="tp-dialog-note">
              Spends tenant credits; you only pay for valid data. Re-revealing this contact in this
              workspace is free.
            </p>
            {insufficient && (
              <div className="tp-inline-alert">
                <p className="tp-inline-alert-msg">{failure?.message}</p>
                <Link className="tp-link-strong" href="/settings/billing">
                  Top up credits →
                </Link>
              </div>
            )}
            {failure && !insufficient && <p className="lw-error">{failure.message}</p>}
            <div className="tp-dialog-actions">
              <button className="tp-btn-ghost" type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="app-button"
                type="button"
                onClick={() => void onConfirm()}
                disabled={busy}
              >
                {busy ? "Revealing…" : "Confirm reveal"}
              </button>
            </div>
          </>
        )}

        {suppressed && (
          <>
            <p className="tp-dialog-note tp-muted-quiet">
              This contact is on a do-not-contact list.
            </p>
            <div className="tp-dialog-actions">
              <button className="app-button" type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            <dl className="tp-reveal-result">
              {result.email !== undefined && result.email !== null && (
                <div className="tp-reveal-pair">
                  <dt>Email</dt>
                  <dd className="tp-reveal-value">
                    {result.email}
                    {result.emailStatus && (
                      <span className="tp-reveal-tag">{result.emailStatus}</span>
                    )}
                  </dd>
                </div>
              )}
              {result.phone !== undefined && result.phone !== null && (
                <div className="tp-reveal-pair">
                  <dt>Phone</dt>
                  <dd className="tp-reveal-value">{result.phone}</dd>
                </div>
              )}
              {!result.email && !result.phone && (
                <p className="app-muted">No contact data was available for this reveal.</p>
              )}
            </dl>
            <p className="tp-reveal-meta">
              {result.alreadyOwned
                ? "Already owned in this workspace — no credits charged."
                : `Charged ${result.creditsCharged} credit${result.creditsCharged === 1 ? "" : "s"}.`}{" "}
              Balance: <strong>{result.balanceAfter.toLocaleString()}</strong> credits.
            </p>
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
