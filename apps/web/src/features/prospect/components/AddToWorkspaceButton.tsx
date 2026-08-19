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
        // The row changes side: it must leave the database half and appear as an owned contact. Invalidate
        // exactly the query families that change — the two searches, the workspace count, the facet counts —
        // NOT the whole ["prospect"] root (perf-audit P3.3): the root nuke refetched every mounted detail
        // section, tags, stages, typeahead memos and reveal reads — dozens of requests for a one-row move.
        for (const family of [
          "contact-search",
          "database-search",
          "database-count",
          "contact-count",
          "contact-facets",
        ]) {
          void queryClient.invalidateQueries({ queryKey: ["prospect", family] });
        }
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
