// entries/pane.ts — the prospect slice's PANE entry (perf-checklist PA-2/PA-3). The Search composer mounts
// this through next/dynamic, and a dynamic import of the MAIN barrel splits nothing — the barrel pulls the
// whole 86-file slice into whatever chunk imports it, which is the exact weld PA-2 removed for /lists and
// /companies. A one-symbol entry is what makes the People pane its own chunk, so a visitor sitting on the
// Accounts tab never downloads it.
//
// The RevealStore provider rides along: the composer mounts it ABOVE both panes and the profile drawers
// (reveal-as-save, decisions.md 2026-08-25), and the pane's chunk already carries the store, so exporting
// it here costs nothing and keeps the composer's cross-feature imports at one.
export { PeoplePane } from "../components/PeoplePane";
export { RevealStoreProvider } from "../hooks/useRevealStore";
