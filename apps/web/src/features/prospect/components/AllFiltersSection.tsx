// AllFiltersSection.tsx — the second tier of the rail (decisions.md 2026-08-25): every facet only the
// workspace engine answers, in accordions, under one collapsible "All filters" header tagged "Saved contacts
// only". Collapsed by default (progressive disclosure); the badge counts active selections so a collapsed
// tier is still legible. In "Not saved" scope nothing here can apply, so the tier says so instead of offering
// controls that would silently do nothing.
"use client";

import type { WorkspaceScope } from "@/components/search";
import type { ContactQuery } from "@leadwolf/types";
import { ALL_FILTER_GROUPS, groupActiveCount, workspaceOnlyChips } from "../filterGroups";
import { useOpenGroups } from "../hooks/useOpenGroups";
import styles from "../prospect.module.css";
import { AccordionGroup } from "./AccordionGroup";
import { FacetControl, type OwnerOption } from "./FacetControl";

const TIER_ID = "search-all-filters";

export function AllFiltersSection({
  query,
  onChange,
  counts,
  owners,
  scope,
}: {
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  counts?: Map<string, number>;
  owners: OwnerOption[];
  scope: WorkspaceScope;
}) {
  const groups = useOpenGroups();
  const active = workspaceOnlyChips(query).length;
  const open = groups.isOpen("all");

  if (scope === "exclude") {
    return (
      <p className={styles.tierNote}>
        Saved-only filters don't apply to people you haven't saved yet. Switch to All or Saved to
        use them.
      </p>
    );
  }

  return (
    <section className={styles.tier}>
      <button
        type="button"
        className={styles.tierHead}
        aria-expanded={open}
        aria-controls={TIER_ID}
        onClick={() => groups.toggle("all")}
      >
        <span className={styles.groupTitle}>
          All filters
          {active > 0 ? <span className={styles.groupBadge}>{active}</span> : null}
        </span>
        <span className={styles.tierTag}>Saved contacts only</span>
        <span aria-hidden className={styles.groupChevron}>
          {open ? "−" : "+"}
        </span>
      </button>
      {open ? (
        <div id={TIER_ID}>
          <p className={styles.tierNote}>
            These narrow the list to contacts already saved in your workspace.
          </p>
          {ALL_FILTER_GROUPS.map((group) => (
            <AccordionGroup
              key={group.id}
              id={`search-group-${group.id}`}
              title={group.title}
              open={groups.isOpen(group.id)}
              onToggle={() => groups.toggle(group.id)}
              badge={
                groupActiveCount(
                  query,
                  group.facets.map((f) => f.field),
                ) || undefined
              }
            >
              {group.facets.map((facet) => (
                <FacetControl
                  key={`${facet.kind}:${facet.field}`}
                  facet={facet}
                  query={query}
                  onChange={onChange}
                  counts={counts}
                  owners={owners}
                />
              ))}
            </AccordionGroup>
          ))}
        </div>
      ) : null}
    </section>
  );
}
