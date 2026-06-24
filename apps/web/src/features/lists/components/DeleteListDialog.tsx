// DeleteListDialog.tsx — the confirm-delete dialog for a list. Delete is owner-only server-side (a non-owned
// id 404s, surfaced as a toast); members cascade. Composition only — the delete call lives in the lists api
// client; the parent reloads (and, on the detail surface, navigates back to the index) on success.
"use client";

import type { List } from "@leadwolf/types";
import { Dialog, TpButton, useToast } from "@leadwolf/ui";
import { useState } from "react";
import { deleteList } from "../api";
import styles from "../lists.module.css";

export function DeleteListDialog({
  open,
  list,
  onClose,
  onDeleted,
}: {
  open: boolean;
  /** The list to delete; null keeps the dialog inert. */
  list: List | null;
  onClose: () => void;
  /** Fired after a successful delete (the parent reloads / navigates). */
  onDeleted?: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!list) return;
    setBusy(true);
    try {
      await deleteList(list.id);
      toast.success("List deleted");
      onDeleted?.();
      onClose();
    } catch (e) {
      toast.error("Could not delete list", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Delete list"
      footer={
        <>
          <TpButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </TpButton>
          <TpButton variant="danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? "Deleting…" : "Delete"}
          </TpButton>
        </>
      }
    >
      <p className={styles.dialogNote}>
        Delete <strong>{list?.name ?? "this list"}</strong>? The list and its{" "}
        {(list?.memberCount ?? 0).toLocaleString()} membership
        {list?.memberCount === 1 ? "" : "s"} are removed. The contacts themselves are not deleted.
        This can’t be undone.
      </p>
    </Dialog>
  );
}
