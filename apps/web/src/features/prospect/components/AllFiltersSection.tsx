// AllFiltersSection.tsx — the second tier of the rail (decisions.md 2026-08-25): every facet only the
// workspace engine answers, under one collapsible "All filters" header tagged "Saved contacts only".
// Collapsed by default (progressive disclosure); the badge counts active selections so a collapsed tier is
// still legible. In "Not saved" scope nothing here can apply, so the tier says so instead of offering
// controls that would silently do nothing.
//
// The header is eager; the BODY (the groups) is next/dynamic — opening the tier is an intent (perf-checklist
// PA-3), and /search has a 200kB First Load budget the quick tier + grid must fit inside.
"use client";

import type { WorkspaceScope } from "@/components/search";
import type { ContactQuery } from "@leadwolf/types";
import dynamic from "next/dynamic";
import { workspaceOnlyChips } from "../filterGroups";
import { useOpenGroups } from "../hooks/useOpenGroups";
import styles from "../prospect.module.css";
import type { OwnerOption } from "./FacetControl";

const AllFiltersBody = dynamic(() => import("./AllFiltersBody").then((m) => m.AllFiltersBody), {
  ssr: false,
  loading: () => <p className={styles.tierNote}>Loading filters…</p>,
});

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
          <AllFiltersBody query={query} onChange={onChange} counts={counts} owners={owners} />
        </div>
      ) : null}
    </section>
  );
}
