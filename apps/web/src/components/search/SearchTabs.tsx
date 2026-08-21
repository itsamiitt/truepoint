// SearchTabs.tsx — the People ⇄ Accounts switch at the top of the Search filter drawer.
//
// Both tabs search the SAME platform database from two angles: People over the person graph, Accounts over
// the company graph. Which one you are on is a property of the view (the URL), not of a route — that is why
// this is a segmented control inside one surface rather than two destinations, and why each tab keeps its
// own filters across a switch.
"use client";

import { SegmentedControl } from "@leadwolf/ui";
import type { SearchTab } from "./searchTabUrlState";

const ITEMS = [
  { value: "people", label: "People" },
  { value: "accounts", label: "Accounts" },
];

export function SearchTabs({
  tab,
  onChange,
  className,
}: {
  tab: SearchTab;
  onChange: (next: SearchTab) => void;
  className?: string;
}) {
  return (
    <SegmentedControl
      items={ITEMS}
      value={tab}
      onChange={(v) => onChange(v as SearchTab)}
      className={className}
      aria-label="Search people or accounts"
    />
  );
}
