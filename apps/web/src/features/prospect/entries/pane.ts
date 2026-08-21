// entries/pane.ts — the prospect slice's PANE entry (perf-checklist PA-2/PA-3). The Search composer mounts
// this through next/dynamic, and a dynamic import of the MAIN barrel splits nothing — the barrel pulls the
// whole 86-file slice into whatever chunk imports it, which is the exact weld PA-2 removed for /lists and
// /companies. A one-symbol entry is what makes the People pane its own chunk, so a visitor sitting on the
// Accounts tab never downloads it.
export { PeoplePane } from "../components/PeoplePane";
