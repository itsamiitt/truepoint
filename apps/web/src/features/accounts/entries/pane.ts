// entries/pane.ts — the accounts slice's PANE entry, the twin of features/prospect/entries/pane.ts and for
// the same reason (perf-checklist PA-2/PA-3): the Search composer mounts this through next/dynamic, so the
// Accounts pane — its grid, its filter panel, its firmographic table — is its own chunk rather than dead
// weight in the first load of a visitor who stays on People.
export { AccountsPane } from "../components/AccountsPane";
