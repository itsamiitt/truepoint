// components/search — the Search surface's SHELL primitives: the collapsible filter drawer, the
// People/Accounts switch, and the URL/preference state behind them.
//
// It lives in components/ rather than in a feature on purpose. Both panes (features/prospect's People pane
// and features/accounts' Accounts pane) need the same drawer, and the composer (features/search) needs the
// same tab state — if the drawer lived in either feature the import graph would close a cycle, which
// `lint:boundaries` rejects (no-circular). This module imports nothing from features, so it cannot.
export { SearchDrawer, SearchDrawerOpener } from "./SearchDrawer";
export type { SearchShell } from "./searchShell";
export { SearchTabs } from "./SearchTabs";
export { useSearchTab, type UseSearchTab } from "./useSearchTab";
export { useDrawerCollapsed, type DrawerState } from "./useDrawerCollapsed";
export {
  DEFAULT_SEARCH_TAB,
  SEARCH_TABS,
  type SearchTab,
  paramsToSearchTab,
  parseSearchTab,
  searchTabFromLegacyScope,
  searchTabToParams,
} from "./searchTabUrlState";
