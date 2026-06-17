// BulkActionBar.tsx — the sticky bulk-action bar shown when one or more prospect rows are selected (04 §5,
// 11 §4.2). Shows the selection count + the live remaining balance, opens the bulk reveal dialog (reusing the
// monetized reveal path), and offers Add-to-list / Enroll (honest "not available yet" against the unbuilt
// backends) + Export CSV (the already-loaded MASKED rows only — no PII, no fabricated data). View composition
// only — the spend + balance are server-side.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { DropdownMenu, TpButton, useToast } from "@leadwolf/ui";
import { Download, ListPlus, MoreHorizontal, Send } from "lucide-react";
import { useState } from "react";
import { addContactsToList, enrollContacts } from "../api";
import { useCreditBalance } from "../hooks/useCreditBalance";
import { exportMaskedCsv } from "../export";
import styles from "../prospect.module.css";
import { BulkRevealDialog } from "./BulkRevealDialog";

export function BulkActionBar({
  count,
  selectedContacts,
  revealableIds,
  onClear,
  onRevealed,
}: {
  /** Total rows currently selected. */
  count: number;
  /** The full selected masked rows (drives the no-PII CSV export). */
  selectedContacts: MaskedContact[];
  /** Selected ids that can actually be revealed (hasEmail && !isRevealed). */
  revealableIds: string[];
  onClear: () => void;
  /** Fired with the ids that were revealed so the parent can flip rows + clear the selection. */
  onRevealed: (revealedIds: string[]) => void;
}) {
  const toast = useToast();
  const { balance } = useCreditBalance();
  const [revealing, setRevealing] = useState(false);
  const revealable = revealableIds.length;

  const notWired = (what: string) =>
    toast.toast({
      title: `${what} isn't available yet`,
      description: "It connects once that backend ships — nothing was changed.",
    });

  const onAddToList = async () => {
    try {
      // No list picker yet; the backend is unbuilt, so this is honest about not being wired.
      const { ok } = await addContactsToList("__default__", selectedContacts.map((c) => c.id));
      if (ok) toast.success("Added to list");
      else notWired("Lists");
    } catch (e) {
      toast.error("Could not add to list", e instanceof Error ? e.message : undefined);
    }
  };

  const onEnroll = async () => {
    try {
      const { ok } = await enrollContacts(selectedContacts.map((c) => c.id));
      if (ok) toast.success("Enrolled");
      else notWired("Sequences");
    } catch (e) {
      toast.error("Could not enroll", e instanceof Error ? e.message : undefined);
    }
  };

  const onExport = () => {
    exportMaskedCsv(selectedContacts);
    toast.success(`Exported ${selectedContacts.length} row${selectedContacts.length === 1 ? "" : "s"}`);
  };

  return (
    <>
      <section className={styles.bulkBar} aria-label="Bulk actions">
        <span className={styles.bulkCount}>{count} selected</span>
        <span className={styles.bulkBalance}>
          Balance <strong>{balance === null ? "—" : balance.toLocaleString()}</strong>
        </span>
        <span className={styles.bulkSep} aria-hidden />
        <div className={styles.bulkActions}>
          <TpButton
            variant="primary"
            size="sm"
            onClick={() => setRevealing(true)}
            disabled={revealable === 0}
            title={revealable === 0 ? "No selected contacts need an email reveal" : undefined}
          >
            Reveal {revealable}
          </TpButton>
          <TpButton variant="ghost" size="sm" leftIcon={<ListPlus size={15} />} onClick={onAddToList}>
            Add to list
          </TpButton>
          <TpButton variant="ghost" size="sm" leftIcon={<Send size={15} />} onClick={onEnroll}>
            Enroll
          </TpButton>
          <DropdownMenu
            trigger={({ toggle }) => (
              <TpButton variant="ghost" size="sm" onClick={toggle} aria-label="More bulk actions">
                <MoreHorizontal size={15} />
              </TpButton>
            )}
            side="top"
            items={[
              {
                label: "Export CSV",
                icon: <Download size={15} />,
                onSelect: onExport,
              },
            ]}
          />
          <TpButton variant="link" size="sm" onClick={onClear}>
            Clear
          </TpButton>
        </div>
      </section>

      <BulkRevealDialog
        contactIds={revealableIds}
        balance={balance}
        open={revealing}
        onClose={() => setRevealing(false)}
        onRevealed={(ids) => {
          onRevealed(ids);
          setRevealing(false);
        }}
      />
    </>
  );
}
