// RailFooter.tsx — the saved + recent searches block UNDER the filters (decisions.md 2026-08-25: a
// first-time user meets the controls before the chrome). Loaded through next/dynamic by PeoplePane
// (perf-checklist PA-3): the saved-search dialogs, menu and client are a real intent, not the page, and
// /search has a 200kB First Load budget the quick tier + grid must fit inside.
"use client";

import type { ContactQuery } from "@leadwolf/types";
import type { RecentSearch } from "../hooks/useRecentSearches";
import { RecentSearches } from "./RecentSearches";
import { SaveSearchPanel } from "./SaveSearchPanel";

export function RailFooter({
  query,
  onApply,
  recents,
  onClearRecents,
}: {
  query: ContactQuery;
  onApply: (q: ContactQuery) => void;
  recents: RecentSearch[];
  onClearRecents: () => void;
}) {
  return (
    <>
      <SaveSearchPanel currentQuery={query} onApply={onApply} />
      <RecentSearches recents={recents} onApply={onApply} onClear={onClearRecents} />
    </>
  );
}
