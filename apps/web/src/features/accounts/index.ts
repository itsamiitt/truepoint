// accounts — the Accounts half of the Search surface, plus the routed company profile page.
//
// This slice was `features/companies` (the MI-1 /companies destination). The search-consolidation decision
// (2026-08-21) retires that destination and folds account search back into Search as a tab, so the index
// page became AccountsPane and the folder took the name of what it actually holds.
export { AccountsPane } from "./components/AccountsPane";
export { useAccountsSearch } from "./hooks/useAccountsSearch";
export { type AccountRow, mergeAccountRows, toDatabaseCompanyQuery } from "./accountRows";
export { CompanyPage } from "./components/CompanyPage";
export { MarketsBoard } from "./components/MarketsBoard";
