// SearchSurface.tsx — the Search destination's composer (search-consolidation 01).
//
// It owns exactly four things and delegates everything else: the active tab (URL-derived, so a view is
// shareable), the filter drawer's collapsed state (localStorage, so it is a preference and not part of the
// search), which profile is open (a URL param, so a drawer is shareable too), and the RevealStore — mounted
// HERE, above both panes and the profile drawers, so a reveal made in a drawer and one made in the grid read
// the same state (reveal-as-save, decisions.md 2026-08-25). It then mounts ONE pane.
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

import {
  SearchTabs,
  useDrawerCollapsed,
  useProfileParam,
  useSearchTab,
  useWorkspaceScope,
} from "@/components/search";
import type { SearchShell } from "@/components/search";
import { RevealStoreProvider } from "@/features/prospect/entries/revealStore";
import { Skeleton, TableSkeleton } from "@leadwolf/ui";
import { useQueryClient } from "@tanstack/react-query";
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

/** The query families that count or list a row by SIDE (saved vs not) — what a reveal-as-save moves. */
const SIDE_FAMILIES = [
  "contact-search",
  "database-search",
  "database-count",
  "contact-count",
  "contact-facets",
] as const;

export function SearchSurface() {
  const { tab, setTab } = useSearchTab();
  const drawer = useDrawerCollapsed();
  const { profile, open, close } = useProfileParam();
  const workspace = useWorkspaceScope();
  const queryClient = useQueryClient();

  const shell: SearchShell = useMemo(
    () => ({
      ...drawer,
      tabs: <SearchTabs tab={tab} onChange={setTab} />,
      openProfile: open,
      workspace,
    }),
    [drawer, tab, setTab, open, workspace],
  );

  // A reveal-as-save made from a PROFILE DRAWER has no grid row to patch in place, so the two searches and the
  // side-counting aggregates refetch (the narrow set the old AddToWorkspaceButton invalidated — never the
  // ["prospect"] root, perf-audit P3.3), plus the profile itself so its "Saved to your workspace" state is
  // the server's, not just this session's. The drawer stays open: the user is reading it.
  const handleMaterialized = useCallback(
    (slug: string) => {
      for (const family of SIDE_FAMILIES) {
        void queryClient.invalidateQueries({ queryKey: ["prospect", family] });
      }
      void queryClient.invalidateQueries({
        queryKey: ["search", "database", "people", "profile", slug],
      });
    },
    [queryClient],
  );

  return (
    <RevealStoreProvider>
      {tab === "accounts" ? <AccountsPane shell={shell} /> : <PeoplePane shell={shell} />}
      {profile ? (
        <SearchProfileHost
          kind={profile.kind}
          profileKey={profile.key}
          onClose={close}
          onMaterialized={handleMaterialized}
        />
      ) : null}
    </RevealStoreProvider>
  );
}
