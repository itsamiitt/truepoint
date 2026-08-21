// useSearchTab.ts — the active Search tab, derived from the URL so a tab is shareable and survives refresh
// and the back button (the same contract the two query codecs already hold). Writes go through
// router.replace, not push: flipping a tab is a view change, not a navigation the user wants to unwind one
// step at a time — and the URL still fully captures the view.
//
// The write deliberately preserves every other param, so the inactive tab's filters (q/sort/f or
// aq/asort/af) stay in the URL while the other tab is showing. That is the whole reason each tab keeps its
// own state across a switch.
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  type SearchTab,
  paramsToSearchTab,
  searchTabFromLegacyScope,
  searchTabToParams,
} from "./searchTabUrlState";

export interface UseSearchTab {
  tab: SearchTab;
  setTab: (next: SearchTab) => void;
}

export function useSearchTab(): UseSearchTab {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tab = useMemo(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    // A legacy ?scope=accounts link wins over an absent ?tab, so an old shared URL lands on Accounts
    // rather than silently on People. An explicit ?tab always wins over the legacy param.
    return params.has("tab")
      ? paramsToSearchTab(params)
      : (searchTabFromLegacyScope(params.get("scope")) ?? paramsToSearchTab(params));
  }, [searchParams]);

  const setTab = useCallback(
    (next: SearchTab) => {
      const params = searchTabToParams(next, new URLSearchParams(searchParams?.toString() ?? ""));
      // Drop the legacy param on any deliberate switch — once the user has chosen a tab, ?scope has
      // nothing left to say and would only fight ?tab on the next read.
      params.delete("scope");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return { tab, setTab };
}
