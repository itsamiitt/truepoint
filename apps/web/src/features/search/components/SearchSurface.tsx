// SearchSurface.tsx — the Search destination's composer (search-consolidation 01).
//
// It owns exactly two things and delegates everything else: the active tab (URL-derived, so a view is
// shareable) and the filter drawer's collapsed state (localStorage, so it is a preference and not part of
// the search). It then mounts ONE pane.
//
// Mounting one pane rather than both is deliberate. The retired Prospect page kept both scopes mounted
// because React forbids conditional hooks, then threaded an `enabled` flag through every hook to stop the
// hidden scope firing requests — four wasted round-trips per visit when that flag was missed. Choosing
// between two CHILD components has no such constraint: the hidden pane simply is not there. Its filters
// survive in the URL and its results survive in the TanStack Query cache, so switching back is instant.
"use client";

import { SearchTabs, useDrawerCollapsed, useSearchTab } from "@/components/search";
import type { SearchShell } from "@/components/search";
import { AccountsPane } from "@/features/accounts";
import { PeoplePane } from "@/features/prospect";
import { useMemo } from "react";

export function SearchSurface() {
  const { tab, setTab } = useSearchTab();
  const drawer = useDrawerCollapsed();

  const shell: SearchShell = useMemo(
    () => ({ ...drawer, tabs: <SearchTabs tab={tab} onChange={setTab} /> }),
    [drawer, tab, setTab],
  );

  return tab === "accounts" ? <AccountsPane shell={shell} /> : <PeoplePane shell={shell} />;
}
