// entries/accounts.ts — the prospect slice's ACCOUNT-SEARCH public entry (perf-checklist PA-2). The
// companies feature reuses the account grid, filter panel, search hooks and the MI sections — through the
// MAIN barrel that reuse cost /companies the whole contact-side slice too (46.6kB gz; the page weighed more
// than /prospect). Same contract-not-module reasoning as entries/bulk.ts; re-exports point at internal
// homes, never "../index".

export { AccountFilterPanel } from "../components/AccountFilterPanel";
export {
  AccountAlumniSection,
  AccountDisplacementSection,
} from "../components/AccountGraphSections";
export {
  ACCOUNT_DEFAULT_VISIBLE_COLUMNS,
  ACCOUNT_TOGGLEABLE_COLUMNS,
  AccountsTable,
} from "../components/AccountsTable";
export { AccountTechnologySection } from "../components/AccountTechnologySections";
export { HeadcountSection } from "../components/HeadcountSection";
export { useAccountFacetCounts } from "../hooks/useAccountFacetCounts";
export { useAccountSearch } from "../hooks/useAccountSearch";
export { useAccountTechnologies } from "../hooks/useAccountTechnologies";
export {
  accountFacetScope,
  accountWorkspaceOnlyFields,
  activeChips,
  clearAllFilters,
  facetLabel as accountFacetLabel,
} from "../accountFilterGroups";
export { orgKindCopy } from "../orgKindCopy";
export { contactsHrefForCompany } from "../searchUrlState";
// The slice's typed API error. Here rather than in the main barrel for the PA-2 reason above: the accounts
// feature needs to THROW the same error type its sibling surface does, and reaching through index.ts for it
// would weld the whole contact-side slice back into the Search route's Accounts tab.
// FOLLOW-UP: apps/web has three copies of this class (prospect, lists, sequences); they belong in
// apps/web/src/lib/, the way `problemMessage` was consolidated by audit 32 · F4.
export { ApiError } from "../api";
