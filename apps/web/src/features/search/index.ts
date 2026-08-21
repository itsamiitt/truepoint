// search — the Search destination (search-consolidation): one surface, two tabs, one platform database.
//
// This slice is composition only. The People pane lives in features/prospect, the Accounts pane in
// features/accounts, and the drawer/tab shell in components/search (which imports no feature, so the
// graph stays acyclic — see lint:boundaries no-circular).
export { SearchSurface } from "./components/SearchSurface";
