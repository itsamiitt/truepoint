// AddToWorkspaceButton.tsx — the row action for a search hit that lives in the platform DATABASE but not
// yet in this workspace (Layer-0-as-database). One click materializes the licensed record into the
// workspace: from then on the row is an ordinary contact — revealable, assignable, listable.
"use client";

import { TpButton, useToast } from "@leadwolf/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { addFromDatabase } from "../databaseSearchApi";

export function AddToWorkspaceButton({ slug, name }: { slug: string; name: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      const res = await addFromDatabase(slug);
      if (res.contactId) {
        toast.success(`Added ${name} to your workspace`);
        // The row changes side: it must leave the database half and appear as an owned contact.
        void queryClient.invalidateQueries({ queryKey: ["prospect"] });
      } else {
        toast.error("Could not add this contact", res.reason);
      }
    } catch (e) {
      toast.error("Could not add this contact", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <TpButton size="sm" variant="secondary" disabled={busy} onClick={add}>
      {busy ? "Adding…" : "Add"}
    </TpButton>
  );
}
