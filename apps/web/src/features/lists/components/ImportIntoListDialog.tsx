// ImportIntoListDialog.tsx — the "Import into list" entry on the Lists surface (list-plan/03 §3). It hosts the
// REUSED import wizard (`@/features/import` barrel) pre-targeted to this list: the user picks a CSV/XLSX, maps
// columns, validates, and runs — and every landed row is added to THIS list (added_via='import'). The dialog
// stays open after the job settles so the import RECEIPT (created/matched/skipped/duplicates/rejected + count
// added to the list) is read in place; "Done" closes it and the parent reloads the members table. The list id
// is passed for targeting, but the SERVER validates it against the workspace — the client id is never trusted.
"use client";

import { ImportWizard } from "@/features/import";
import type { List } from "@leadwolf/types";
import { Dialog, TpButton } from "@leadwolf/ui";

export function ImportIntoListDialog({
  open,
  list,
  onClose,
  onImported,
}: {
  open: boolean;
  list: List | null;
  onClose: () => void;
  /** Fired once per completed import so the parent can reload the members table + list member count. */
  onImported: () => void;
}) {
  if (!list) return null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Import into “${list.name}”`}
      maxWidth={760}
      footer={
        <TpButton variant="secondary" onClick={onClose}>
          Done
        </TpButton>
      }
    >
      <ImportWizard targetListId={list.id} targetListName={list.name} onImported={onImported} />
    </Dialog>
  );
}
