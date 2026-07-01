// RevealCell.tsx — the per-row, in-grid reveal affordance for the email/phone columns (Phase 2, enterprise
// "Access email/phone" pattern). Owned fields render the real value inline with a color-coded verification
// badge + copy; unrevealed fields render a one-click reveal button showing the credit cost up front. The
// reveal runs through the RevealStore (optimistic in-grid update + a synchronous re-entry guard so a
// double-click can't double-charge). Success/error is toasted; the row's coarse isRevealed flag is flipped via
// onRevealed so the detail drawer stays consistent.
"use client";

import type { MaskedContact, RevealType } from "@leadwolf/types";
import { StatusBadge, TpButton, useToast } from "@leadwolf/ui";
import { Sparkles } from "lucide-react";
import { ownedRevealTypes, useRevealStore } from "../hooks/useRevealStore";
import styles from "../prospect.module.css";
import { emailStatusLabel, emailStatusTone, phoneLineTypeLabel, phoneStatusTone } from "../types";
import { CopyButton } from "./CopyButton";

export function RevealCell({
  contact,
  field,
  onRevealed,
}: {
  contact: MaskedContact;
  field: "email" | "phone";
  /** Flip the row's coarse isRevealed flag after a successful reveal (keeps the drawer/other surfaces in sync). */
  onRevealed?: (contactId: string) => void;
}) {
  const store = useRevealStore();
  const toast = useToast();

  const has = field === "email" ? contact.hasEmail : contact.hasPhone;
  if (!has) return <span className={styles.glyphNone}>—</span>;

  const revealed = store.getRevealed(contact.id);
  const owned = ownedRevealTypes(contact.revealedTypes, revealed);
  const isOwned = field === "email" ? owned.email : owned.phone;
  const value = field === "email" ? revealed?.email : revealed?.phone;
  const label = field === "email" ? "Email" : "Phone";

  // Owned + hydrated → show the real value inline with a copy control + verification badge.
  if (isOwned && value) {
    return (
      <span className={styles.revealedCell}>
        <span className={styles.revealedCellText}>{value}</span>
        {field === "email" && revealed?.emailStatus ? (
          <StatusBadge tone={emailStatusTone(revealed.emailStatus)}>
            {emailStatusLabel(revealed.emailStatus)}
          </StatusBadge>
        ) : null}
        {field === "phone" && phoneLineTypeLabel(revealed?.phoneLineType ?? null) ? (
          <StatusBadge tone={phoneStatusTone(revealed?.phoneStatus ?? null)}>
            {phoneLineTypeLabel(revealed?.phoneLineType ?? null)}
          </StatusBadge>
        ) : null}
        <CopyButton value={value} label={label} />
      </span>
    );
  }

  // Owned but the inline value isn't hydrated yet (hydration in flight / failed) — show a "Revealed" chip; the
  // value is one drawer-open away and NEVER re-charged.
  if (isOwned) return <StatusBadge tone="success">Revealed</StatusBadge>;

  // Not owned → the one-click reveal affordance with the credit cost up front.
  const cost = store.costs ? (field === "email" ? store.costs.email : store.costs.phone) : null;
  const busy = store.isRevealing(contact.id, field as RevealType);

  const onReveal = async () => {
    const res = await store.reveal(contact.id, field as RevealType);
    if (res.ok && res.result) {
      onRevealed?.(contact.id);
      toast.success(
        res.result.alreadyOwned ? "Already owned — no credits charged" : `${label} revealed`,
        res.result.alreadyOwned
          ? undefined
          : `Charged ${res.result.creditsCharged} credit${res.result.creditsCharged === 1 ? "" : "s"}.`,
      );
    } else if (res.error && res.code !== undefined) {
      toast.error(
        res.code === "insufficient_credits" ? "Not enough credits" : "Reveal failed",
        res.error,
      );
    } else if (res.error && res.error !== "A reveal is already in progress.") {
      toast.error("Reveal failed", res.error);
    }
  };

  return (
    <TpButton
      size="sm"
      variant="secondary"
      loading={busy}
      leftIcon={<Sparkles size={13} />}
      onClick={(e) => {
        e.stopPropagation();
        void onReveal();
      }}
    >
      {label}
      {cost != null ? ` · ${cost}cr` : ""}
    </TpButton>
  );
}
