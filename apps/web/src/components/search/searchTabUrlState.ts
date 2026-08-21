// searchTabUrlState.ts — the pure codec for the Search surface's active tab (`?tab=`). Kept separate from
// the two query codecs (searchUrlState's q/sort/f for People, useAccountSearch's aq/asort/af for Accounts)
// because it is orthogonal to both: switching tabs must not touch either query, and both queries must
// survive in the URL while the other tab is showing. That is what makes a tab switch free — the inactive
// tab's filters and results are still addressable, so coming back restores them from the URL + the RQ cache.
//
// `people` is the default and is therefore OMITTED from the URL, so a pristine Search view is just /search.
// Pure module: no React, no DOM beyond URLSearchParams. Unit-tested.

export const SEARCH_TABS = ["people", "accounts"] as const;
export type SearchTab = (typeof SEARCH_TABS)[number];

export const DEFAULT_SEARCH_TAB: SearchTab = "people";

const TAB_PARAM = "tab";

/** Narrow an untrusted string to a SearchTab; anything unrecognised falls back to the default. */
export function parseSearchTab(raw: string | null | undefined): SearchTab {
  return SEARCH_TABS.includes(raw as SearchTab) ? (raw as SearchTab) : DEFAULT_SEARCH_TAB;
}

/** Read the active tab from URL params. A hand-mangled or stale value degrades to `people`, never throws. */
export function paramsToSearchTab(params: URLSearchParams): SearchTab {
  return parseSearchTab(params.get(TAB_PARAM));
}

/**
 * Write the tab onto a CALLER-SUPPLIED params object (fresh by default), leaving every other param intact —
 * both query codecs write onto the same object the same way, so none of the three clobbers the others.
 * The default tab is removed rather than written, keeping a pristine URL clean.
 */
export function searchTabToParams(tab: SearchTab, into?: URLSearchParams): URLSearchParams {
  const params = into ?? new URLSearchParams();
  if (tab === DEFAULT_SEARCH_TAB) params.delete(TAB_PARAM);
  else params.set(TAB_PARAM, tab);
  return params;
}

/**
 * The legacy `?scope=accounts` deep link (the retired Prospect surface's account scope, later redirected to
 * /companies by the MI-1 cutover) maps onto the Accounts tab. Kept so a link shared in either era still
 * lands on the right tab. REMOVE AFTER: one release past the search-consolidation cutover.
 */
export function searchTabFromLegacyScope(scope: string | null | undefined): SearchTab | null {
  return scope === "accounts" ? "accounts" : null;
}
