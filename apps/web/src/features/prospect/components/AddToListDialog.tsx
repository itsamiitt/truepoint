// AddToListDialog.tsx — a shared "add to list" picker: choose an existing workspace list OR create a new one,
// then add the given contacts to it. This is the single list-picker the app reuses for adding a contact to a
// list outside the bulk bar (the RecordDetail "Add to list" action — 05-prospect-to-list). It composes the
// WORKING membership path: bulkResourcesApi.fetchLists/createList (the read/create seam) + bulkActionsApi
// .bulkAddToList (the membership write that hits POST /lists/:id/members). It never invents a list id — the id
// always comes from the picker or a freshly-created list, so the server can always resolve it. It lives in the
// prospect slice (next to the bulk client it uses) so the lists slice can depend on prospect one-way (no cycle).
"use client";

import type { List } from "@leadwolf/types";
import { Dialog, FieldGroup, TpButton, TpInput, TpSelect, useToast } from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { bulkAddToList } from "../bulkActionsApi";
import { createList, fetchLists } from "../bulkResourcesApi";
import styles from "../prospect.module.css";

export function AddToListDialog({
  open,
  contactIds,
  onClose,
  onAdded,
}: {
  open: boolean;
  /** The contacts to add (the lists endpoint takes an explicit id list — no select-all-across-search here). */
  contactIds: string[];
  onClose: () => void;
  /** Fired with the server-returned affected count after a successful add, so the caller can toast/refresh. */
  onAdded?: (affected: number) => void;
}) {
  const toast = useToast();
  const [lists, setLists] = useState<List[] | null>(null);
  const [listId, setListId] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  // Lazily load the workspace's lists the first time the dialog opens.
  const load = useCallback(async () => {
    try {
      setLists(await fetchLists());
    } catch {
      setLists([]);
    }
  }, []);
  useEffect(() => {
    if (open && lists === null) void load();
  }, [open, lists, load]);

  // Reset the picked target each time the dialog opens, so a stale selection never carries over.
  useEffect(() => {
    if (open) {
      setListId("");
      setNewName("");
    }
  }, [open]);

  const canSubmit = contactIds.length > 0 && (listId !== "" || newName.trim() !== "");

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      let targetId = listId;
      if (!targetId && newName.trim()) {
        targetId = (await createList(newName.trim())).id;
      }
      if (!targetId) return;
      const { affected } = await bulkAddToList(targetId, contactIds);
      toast.success(
        `Added to list — ${affected.toLocaleString()} contact${affected === 1 ? "" : "s"}`,
      );
      onAdded?.(affected);
      onClose();
    } catch (e) {
      toast.error("Could not add to list", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const count = contactIds.length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add to list"
      description={`Add the ${count.toLocaleString()} selected contact${count === 1 ? "" : "s"} to a list.`}
      footer={
        <>
          <TpButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </TpButton>
          <TpButton onClick={() => void submit()} disabled={busy || !canSubmit}>
            {busy ? "Adding…" : "Add"}
          </TpButton>
        </>
      }
    >
      <div className={styles.dialogStack}>
        <FieldGroup label="Existing list" htmlFor="tp-add-list-existing">
          <TpSelect
            id="tp-add-list-existing"
            value={listId}
            onChange={(e) => {
              setListId(e.target.value);
              if (e.target.value) setNewName("");
            }}
            disabled={lists === null || busy}
          >
            <option value="">{lists === null ? "Loading…" : "Choose a list…"}</option>
            {(lists ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </TpSelect>
        </FieldGroup>
        <FieldGroup label="New list name" htmlFor="tp-add-list-new">
          <TpInput
            id="tp-add-list-new"
            value={newName}
            maxLength={120}
            placeholder="or create a new list…"
            disabled={busy}
            onChange={(e) => {
              setNewName(e.target.value);
              if (e.target.value) setListId("");
            }}
          />
        </FieldGroup>
      </div>
    </Dialog>
  );
}
