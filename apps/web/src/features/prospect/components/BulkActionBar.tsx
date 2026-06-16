// BulkActionBar.tsx — the sticky bulk-action bar shown when one or more prospect rows are selected (04 §5,
// 11 §4.2). Shows the selection count + the live remaining balance, opens the bulk reveal dialog (reusing
// the monetized reveal path), offers an add-to-list stub, and a clear-selection action. View composition
// only — the spend + balance are server-side.
"use client";

import { useState } from "react";
import { useCreditBalance } from "../hooks/useCreditBalance";
import { BulkRevealDialog } from "./BulkRevealDialog";

export function BulkActionBar({
  count,
  revealableIds,
  onClear,
  onRevealed,
}: {
  /** Total rows currently selected. */
  count: number;
  /** Selected ids that can actually be revealed (hasEmail && !isRevealed). */
  revealableIds: string[];
  onClear: () => void;
  /** Fired with the ids that were revealed so the parent can flip rows + clear the selection. */
  onRevealed: (revealedIds: string[]) => void;
}) {
  const { balance } = useCreditBalance();
  const [revealing, setRevealing] = useState(false);
  const revealable = revealableIds.length;

  return (
    <div className="tp-bulk-bar" role="region" aria-label="Bulk actions">
      <span className="tp-bulk-count">{count} selected</span>
      <span className="tp-bulk-balance">
        Balance: <strong>{balance === null ? "—" : balance.toLocaleString()}</strong> credits
      </span>
      <div className="tp-bulk-actions">
        <button className="tp-btn-ghost" type="button" disabled title="Lists are coming soon">
          Add to list
        </button>
        <button
          className="app-button"
          type="button"
          onClick={() => setRevealing(true)}
          disabled={revealable === 0}
          title={revealable === 0 ? "No selected contacts need an email reveal" : undefined}
        >
          Reveal {revealable}
        </button>
        <button className="tp-link-quiet" type="button" onClick={onClear}>
          Clear
        </button>
      </div>

      {revealing && (
        <BulkRevealDialog
          contactIds={revealableIds}
          balance={balance}
          onClose={() => setRevealing(false)}
          onRevealed={(ids) => {
            onRevealed(ids);
            setRevealing(false);
          }}
        />
      )}
    </div>
  );
}
