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
export { AccountsTable } from "../components/AccountsTable";
export { AccountTechnologySection } from "../components/AccountTechnologySections";
export { HeadcountSection } from "../components/HeadcountSection";
export { useAccountFacetCounts } from "../hooks/useAccountFacetCounts";
export { useAccountSearch } from "../hooks/useAccountSearch";
export { useAccountTechnologies } from "../hooks/useAccountTechnologies";
export { orgKindCopy } from "../orgKindCopy";
export { contactsHrefForCompany } from "../searchUrlState";
