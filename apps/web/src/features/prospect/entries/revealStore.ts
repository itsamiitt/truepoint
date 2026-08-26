// entries/revealStore.ts — the prospect slice's REVEAL-STORE entry (perf-checklist PA-2 shape). The person
// profile drawer in the accounts feature loads `DatabaseProfileRevealActions` from here with next/dynamic
// (reveal-as-save, decisions.md 2026-08-25) — through this entry, never the main barrel, which would weld
// the whole contact-side slice into the drawer's chunk. The provider itself is exported from `entries/pane`
// beside the People pane, whose chunk already carries the store.
export { DatabaseProfileRevealActions } from "../components/DatabaseProfileRevealActions";
export {
  type DatabaseRevealAttempt,
  type RevealAttempt,
  type RevealStore,
  RevealStoreProvider,
  ownedRevealTypes,
  useDatabaseRevealEnabled,
  useIsRevealing,
  useRevealCosts,
  useRevealStore,
  useRevealedContact,
} from "../hooks/useRevealStore";
