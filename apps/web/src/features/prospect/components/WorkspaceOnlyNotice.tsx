// WorkspaceOnlyNotice.tsx — the one line that explains the surface's least obvious behaviour (decisions.md
// 2026-08-25): a saved-only filter (status, owner, a date, a score…) narrows the list to saved contacts,
// so people from the TruePoint database drop out. Before this, they vanished silently and the user had no
// way to know why. Renders nothing when no such filter is active; one action puts everyone back.
"use client";

import type { ContactQuery } from "@leadwolf/types";
import { TpButton } from "@leadwolf/ui";
import { workspaceOnlyChips } from "../filterGroups";
import styles from "../prospect.module.css";

export function WorkspaceOnlyNotice({
  query,
  onChange,
}: {
  query: ContactQuery;
  onChange: (next: ContactQuery) => void;
}) {
  const chips = workspaceOnlyChips(query);
  if (chips.length === 0) return null;
  const facets = [...new Set(chips.map((c) => c.facet))];
  const named =
    facets.length <= 2
      ? facets.join(" and ")
      : `${facets.slice(0, -1).join(", ")} and ${facets[facets.length - 1]}`;
  return (
    <output className={styles.notice}>
      <span>
        Showing saved contacts only — {named} {facets.length === 1 ? "applies" : "apply"} to saved
        contacts.
      </span>
      <TpButton
        variant="link"
        size="sm"
        onClick={() => onChange(chips.reduce((q, c) => c.remove(q), query))}
      >
        Show everyone
      </TpButton>
    </output>
  );
}
