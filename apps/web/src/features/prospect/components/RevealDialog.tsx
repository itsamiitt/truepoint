// RevealDialog.tsx — the reveal confirmation modal on the foundation Dialog (04 §5 "Reveal interaction",
// 09 §3.2). Before confirm it states the honest cost note ("you only pay for valid data"); on confirm it runs
// the reveal via useReveal, toasts the result, then shows the revealed email/phone inline + the new tenant
// balance. It handles the two money-loop failure modes inline — insufficient_credits (402) links to top-up,
// suppressed (403) shows the quiet DNC notice — so the flow has no dead ends. Cost/charge/gate run server-side.
"use client";

import type { MaskedContact, RevealType } from "@leadwolf/types";
import { Dialog, StatusBadge, TpButton, useToast } from "@leadwolf/ui";
import Link from "next/link";
import { useEffect } from "react";
import { useReveal } from "../hooks/useReveal";
import styles from "../prospect.module.css";
import { displayName } from "../types";

const REVEAL_LABELS: Record<RevealType, string> = {
  email: "email",
  phone: "phone",
  full_profile: "full profile",
};

export function RevealDialog({
  contact,
  revealType,
  open,
  onClose,
  onRevealed,
}: {
  contact: MaskedContact;
  revealType: RevealType;
  open: boolean;
  onClose: () => void;
  /** Fired after a successful reveal so the parent can flip the row to revealed. */
  onRevealed: (contactId: string) => void;
}) {
  const toast = useToast();
  const { result, failure, busy, run, reset } = useReveal();

  // Reset the hook state whenever the dialog opens so nothing stale shows from a prior contact/run.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  async function onConfirm(): Promise<void> {
    const res = await run(contact.id, revealType);
    if (res) {
      onRevealed(contact.id);
      toast.success(
        res.alreadyOwned ? "Already owned — no credits charged" : "Contact revealed",
        res.alreadyOwned ? undefined : `Charged ${res.creditsCharged} credit${res.creditsCharged === 1 ? "" : "s"}.`,
      );
    }
  }

  const insufficient = failure?.code === "insufficient_credits";
  const suppressed = failure?.code === "suppressed";

  const footer = suppressed ? (
    <TpButton variant="secondary" onClick={onClose}>
      Close
    </TpButton>
  ) : result ? (
    <TpButton onClick={onClose}>Done</TpButton>
  ) : (
    <>
      <TpButton variant="ghost" onClick={onClose} disabled={busy}>
        Cancel
      </TpButton>
      <TpButton onClick={() => void onConfirm()} loading={busy}>
        Confirm reveal
      </TpButton>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Reveal ${REVEAL_LABELS[revealType]}`}
      description={displayName(contact)}
      footer={footer}
      maxWidth={420}
    >
      {!result && !suppressed && (
        <>
          <p className={styles.dialogNote}>
            Spends tenant credits; you only pay for valid data. Re-revealing this contact in this
            workspace is free.
          </p>
          {insufficient && (
            <div className={styles.inlineAlert}>
              <p className={styles.inlineAlertMsg}>{failure?.message}</p>
              <Link className={styles.topupLink} href="/settings/billing">
                Top up credits →
              </Link>
            </div>
          )}
          {failure && !insufficient && (
            <div className={styles.inlineAlert}>
              <p className={styles.inlineAlertMsg}>{failure.message}</p>
            </div>
          )}
        </>
      )}

      {suppressed && (
        <p className={styles.dialogNote}>This contact is on a do-not-contact list.</p>
      )}

      {result && (
        <>
          <dl className={styles.revealResult}>
            {result.email != null && result.email !== "" && (
              <div className={styles.revealPair}>
                <dt className={styles.revealKey}>Email</dt>
                <dd className={styles.revealValue}>
                  {result.email}
                  {result.emailStatus && <StatusBadge tone="muted">{result.emailStatus}</StatusBadge>}
                </dd>
              </div>
            )}
            {result.phone != null && result.phone !== "" && (
              <div className={styles.revealPair}>
                <dt className={styles.revealKey}>Phone</dt>
                <dd className={styles.revealValue}>{result.phone}</dd>
              </div>
            )}
            {!result.email && !result.phone && (
              <p className={styles.dialogNote}>No contact data was available for this reveal.</p>
            )}
          </dl>
          <p className={styles.revealMeta}>
            {result.alreadyOwned
              ? "Already owned in this workspace — no credits charged."
              : `Charged ${result.creditsCharged} credit${result.creditsCharged === 1 ? "" : "s"}.`}{" "}
            Balance: <strong>{result.balanceAfter.toLocaleString()}</strong> credits.
          </p>
        </>
      )}
    </Dialog>
  );
}
