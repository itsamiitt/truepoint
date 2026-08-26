// entries/revealStore.ts — the prospect slice's REVEAL-STORE entry (perf-checklist PA-2 shape). The Search
// composer mounts the provider ABOVE both panes and the profile drawers (reveal-as-save, decisions.md
// 2026-08-25), and the accounts feature's person profile drawer reads the same store — through this entry,
// never the main barrel, which would weld the whole contact-side slice into the Accounts tab's chunk.
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
