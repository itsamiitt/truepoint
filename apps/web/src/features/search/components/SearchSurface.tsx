// SearchSurface.tsx — the Search destination's composer (search-consolidation 01).
//
// It owns exactly three things and delegates everything else: the active tab (URL-derived, so a view is
// shareable), the filter drawer's collapsed state (localStorage, so it is a preference and not part of the
// search), and which profile is open (a URL param, so a drawer is shareable too). It then mounts ONE pane.
//
// Mounting one pane rather than both is deliberate. The retired Prospect page kept both scopes mounted
// because React forbids conditional hooks, then threaded an `enabled` flag through every hook to stop the
// hidden scope firing requests — four wasted round-trips per visit when that flag was missed. Choosing
// between two CHILD components has no such constraint: the hidden pane simply is not there. Its filters
// survive in the URL and its results in the TanStack Query cache, so switching back is instant.
//
// BOTH PANES ARE INTENT-DEFERRED (perf-checklist PA-3). Statically importing them put People AND Accounts —
// two grids, two filter panels, the account table, the profile drawers — into the route's first load, and
// /search measured 214kB against the checklist's 200kB target. A visitor uses exactly one tab at a time, so
// the other pane is code they downloaded and never ran. `ssr: false` because the surface is URL-driven
// client state that has no meaningful server render; the skeleton below matches the grid shape so arriving
// data does not shift the layout (design interaction rules).
"use client";

import { SearchTabs, useDrawerCollapsed, useProfileParam, useSearchTab } from "@/components/search";
import type { SearchShell } from "@/components/search";
import { Skeleton, TableSkeleton } from "@leadwolf/ui";
import dynamic from "next/dynamic";
import { useCallback, useMemo } from "react";
import { SearchProfileHost } from "./SearchProfileHost";

/** Shape-matched to the grid so the swap to real rows costs no layout shift (and matches loading.tsx). */
function PaneSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-4)" }}>
      <Skeleton width={200} height={20} />
      <TableSkeleton rows={10} />
    </div>
  );
}

// People is EAGER on purpose, and Accounts is not. PA-3 defers things behind an INTENT — the Cmd-K palette,
// the bulk bar, a wizard dialog — and the People pane is not an intent, it is the page: it renders on
// essentially every visit, so deferring it would buy bundle size with a round trip on the critical path
// before the first row can even be requested. Accounts is a genuine intent (a tab the visitor has to
// choose), so its grid, its filter panel and the profile drawers stay out of the default first load.
//
// Measured First Load JS on a clean production build, against the perf-checklist's 200kB target:
//   eager both                        214kB   over target
//   eager People, deferred Accounts   197kB   ← chosen
//   deferred both                     117kB   under target, but the default view then waits on a chunk
//                                             fetch before it can even issue its first search
// The 80kB the third option saves is real, and it is bought with a round trip in front of every cold visit
// to the page reps live on. Deferring the thing the user came for is not a performance win.
import { PeoplePane } from "@/features/prospect/entries/pane";

const AccountsPane = dynamic(
  () => import("@/features/accounts/entries/pane").then((m) => m.AccountsPane),
  { ssr: false, loading: () => <PaneSkeleton /> },
);

export function SearchSurface() {
  const { tab, setTab } = useSearchTab();
  const drawer = useDrawerCollapsed();
  const { profile, open, close } = useProfileParam();

  const shell: SearchShell = useMemo(
    () => ({
      ...drawer,
      tabs: <SearchTabs tab={tab} onChange={setTab} />,
      openProfile: open,
    }),
    [drawer, tab, setTab, open],
  );

  // Adding from a profile drawer closes it: the record is now an ordinary workspace row, and leaving the
  // global profile open would show a stale "not in your workspace" state over a record that just joined it.
  const handleAdded = useCallback(() => close(), [close]);

  return (
    <>
      {tab === "accounts" ? <AccountsPane shell={shell} /> : <PeoplePane shell={shell} />}
      {profile ? (
        <SearchProfileHost
          kind={profile.kind}
          profileKey={profile.key}
          onClose={close}
          onAddToWorkspace={handleAdded}
        />
      ) : null}
    </>
  );
}
