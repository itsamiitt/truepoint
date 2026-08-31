// RevealCell.tsx — the per-row, in-grid reveal affordance for the email/phone columns (Phase 2, enterprise
// "Access email/phone" pattern). Owned fields render the real value inline with a color-coded verification
// badge + copy; unrevealed fields render a one-click reveal button showing the credit cost up front. The
// reveal runs through the RevealStore (optimistic in-grid update + a synchronous re-entry guard so a
// double-click can't double-charge). Success/error is toasted; the row's coarse isRevealed flag is flipped via
// onRevealed so the detail drawer stays consistent.
//
// A NOT-SAVED row (a database person) gets the same button, and its reveal IS the save gesture (decisions.md
// 2026-08-25): one request materializes the person and reveals the channel, then `onMaterialized` flips the
// row in place. What a row may do is decided by rowAffordances — never inline.
"use client";

import type { MaskedContact, RevealType } from "@leadwolf/types";
import { StatusBadge, Tooltip, TpButton, useToast } from "@leadwolf/ui";
import { Sparkles } from "lucide-react";
import { type ProspectRow, ownedRowFromDatabase } from "../databaseRows";
import {
  ownedRevealTypes,
  useDatabaseRevealEnabled,
  useIsRevealing,
  useRevealCosts,
  useRevealStore,
  useRevealedContact,
} from "../hooks/useRevealStore";
import styles from "../prospect.module.css";
import { rowAffordances } from "../rowAffordances";
import { emailStatusLabel, emailStatusTone, phoneLineTypeLabel, phoneStatusTone } from "../types";
import { ChannelValuesPopover } from "./ChannelValuesPopover";
import { CopyButton } from "./CopyButton";

const IN_PROGRESS = "A reveal is already in progress.";

export function RevealCell({
  contact,
  field,
  onRevealed,
  onMaterialized,
}: {
  contact: ProspectRow;
  field: "email" | "phone";
  /** Flip the row's coarse isRevealed flag after a successful reveal (keeps the drawer/other surfaces in sync). */
  onRevealed?: (contactId: string) => void;
  /** A database row became a workspace contact (reveal-as-save) — render it in place. */
  onMaterialized?: (slug: string, row: MaskedContact) => void;
}) {
  const store = useRevealStore();
  const toast = useToast();
  // Per-slice subscriptions (perf-audit P3.1b): this cell re-renders when ITS row's data, ITS in-flight flag,
  // or the costs change — a reveal/hydrate elsewhere in the grid no longer touches it. Hooks run before the
  // no-field early return below (React's rules; the subscriptions are cheap either way).
  const revealed = useRevealedContact(contact.id);
  const busy = useIsRevealing(contact.id, field as RevealType);
  const costs = useRevealCosts();
  const databaseRevealEnabled = useDatabaseRevealEnabled();
  const affordance = rowAffordances(contact, { databaseRevealEnabled });

  const has = field === "email" ? contact.hasEmail : contact.hasPhone;
  if (!has) return <span className={styles.glyphNone}>—</span>;
  const label = field === "email" ? "Email" : "Phone";
  // The masked per-value summaries (counts only, no values) — lets an UNREVEALED cell say how many values
  // one reveal unlocks ("3 emails · 2cr"), which is the honest sell for the multi-value record.
  const maskedCount =
    field === "email" ? contact.channels?.emailCount : contact.channels?.phoneCount;

  if (!affordance.reveal[field]) {
    // The person carries the channel, but reveal-as-save is switched off for this deployment: "on file" is
    // the honest word — "—" would claim there is nothing here. The count rides along when there are several.
    return (
      <Tooltip label="Revealing from the TruePoint database isn't enabled yet">
        <span className={styles.glyphNone}>
          {maskedCount !== undefined && maskedCount > 1 ? `${maskedCount} on file` : "On file"}
        </span>
      </Tooltip>
    );
  }

  const owned = ownedRevealTypes(contact.revealedTypes, revealed);
  const isOwned = field === "email" ? owned.email : owned.phone;
  const value = field === "email" ? revealed?.email : revealed?.phone;
  // ALL live values of this channel (S-CH4, primary-first) — present only when the read gate is on and the
  // hydrate carried them. Length > 1 renders the "+N" popover beside the primary (Search v4).
  const allValues = field === "email" ? revealed?.emails : revealed?.phones;

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
        {allValues ? <ChannelValuesPopover field={field} values={allValues} /> : null}
      </span>
    );
  }

  // Owned but the inline value isn't hydrated yet (hydration in flight / failed) — show a "Revealed" chip; the
  // value is one drawer-open away and NEVER re-charged.
  if (isOwned) return <StatusBadge tone="success">Revealed</StatusBadge>;

  // Not owned → the one-click reveal affordance with the credit cost up front.
  const cost = costs ? (field === "email" ? costs.email : costs.phone) : null;
  const charged = (n: number) => `Charged ${n} credit${n === 1 ? "" : "s"}.`;

  const revealOwned = async () => {
    const res = await store.reveal(contact.id, field as RevealType);
    if (res.ok && res.result) {
      onRevealed?.(contact.id);
      // `nothingToReveal` FIRST: `alreadyOwned` is also true when the record simply has no such field, so
      // checking it first told the user they already owned a contact we hold nothing for (S-12).
      if (res.result.nothingToReveal) {
        // success tone, not error: nothing failed — we simply hold no such field for this contact.
        toast.success(`No ${label.toLowerCase()} on file`, "Nothing was charged.");
      } else {
        toast.success(
          res.result.alreadyOwned ? "Already owned — no credits charged" : `${label} revealed`,
          res.result.alreadyOwned ? undefined : charged(res.result.creditsCharged),
        );
      }
    } else if (res.error && res.code !== undefined) {
      toast.error(
        res.code === "insufficient_credits" ? "Not enough credits" : "Reveal failed",
        res.error,
      );
    } else if (res.error && res.error !== IN_PROGRESS) {
      toast.error("Reveal failed", res.error);
    }
  };

  // Reveal IS the save gesture: the landing commits before the reveal runs, so the person is saved whenever a
  // contactId comes back — success or a failed reveal alike — and the row flips either way.
  const revealAndSave = async () => {
    const slug = contact.databaseSlug as string;
    const res = await store.revealFromDatabase(slug, field as RevealType);
    if (res.contactId) {
      onMaterialized?.(
        slug,
        ownedRowFromDatabase(
          contact,
          res.contactId,
          res.presence,
          res.ok ? (field as RevealType) : undefined,
        ),
      );
    }
    if (res.ok && res.result) {
      onRevealed?.(res.contactId ?? contact.id);
      if (res.result.nothingToReveal) {
        toast.success(
          "Saved to your workspace",
          `No ${label.toLowerCase()} on file — nothing was charged.`,
        );
      } else {
        toast.success(
          `${label} revealed · saved to your workspace`,
          res.result.alreadyOwned
            ? "Already owned — no credits charged."
            : charged(res.result.creditsCharged),
        );
      }
    } else if (res.error && res.error !== IN_PROGRESS) {
      toast.error(
        res.contactId
          ? "Saved to your workspace — reveal failed"
          : res.code === "insufficient_credits"
            ? "Not enough credits"
            : "Reveal failed",
        res.error,
      );
    }
  };

  // One reveal unlocks EVERY value of the channel (reveal is contact × type grained), so when the masked
  // summaries say there is more than one, the button says what the click actually buys: "3 emails · 2cr".
  const buttonLabel =
    maskedCount !== undefined && maskedCount > 1 ? `${maskedCount} ${label.toLowerCase()}s` : label;
  const button = (
    // Ghost + cobalt (Search v4): the reveal reads as a quiet in-cell action, not a pill — the cost stays.
    <TpButton
      size="sm"
      variant="ghost"
      className={styles.revealAction}
      loading={busy}
      leftIcon={<Sparkles size={13} />}
      onClick={(e) => {
        e.stopPropagation();
        void (affordance.saved ? revealOwned() : revealAndSave());
      }}
    >
      {buttonLabel}
      {cost != null ? ` · ${cost}cr` : ""}
    </TpButton>
  );
  return affordance.saved ? (
    button
  ) : (
    <Tooltip label={`Reveals the ${label.toLowerCase()} and saves this person to your workspace`}>
      {button}
    </Tooltip>
  );
}
