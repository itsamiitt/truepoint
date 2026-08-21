// entries/bulk.ts — the prospect slice's BULK + MASKING public entry (perf-checklist PA-2). The lists
// feature composes the bulk bar, the masked quick-view, the selection model and the masking helpers — and
// importing them through the MAIN barrel welded the entire 86-file slice (FilterRail, AiSearch,
// StageManagement, ProspectPage…) into /lists' first load: 46.6kB gz of it, making /lists heavier than
// /prospect itself. A named entry is a public contract exactly like the barrel (the depcruise
// no-cross-feature-import rule sanctions `entries/*` alongside `index.*`) — it just isn't one module with
// everything else. Re-exports point at the INTERNAL homes, never "../index", or the split would be undone.

export { BulkActionBar, type RowBulkAction } from "../components/BulkActionBar";
export { QuickViewDrawer } from "../components/QuickViewDrawer";
export { RowSelectCheckbox, SelectAllCheckbox } from "../components/SelectionControls";
export { bulkEnrich, bulkEstimate } from "../bulkActionsApi";
export { useBulkSelection, useBulkSelectionStore } from "../hooks/useBulkSelection";
export { useTags } from "../hooks/useTags";
export { displayName, emailGlyphFor, maskedEmail } from "../types";
