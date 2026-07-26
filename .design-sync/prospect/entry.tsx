// entry.tsx — the design-sync entry for the prospect feature slice.
//
// Everything below is the app's REAL component, imported from apps/web unmodified. What changes is only
// what sits under them: ./stubs/* replace next/navigation, next/link, lucide-react, and the two @/lib
// modules at bundle time (see the alias map in .design-sync/build-ui.mjs), so the slice runs against
// ../fixtures instead of the network. No component is reimplemented or forked here.
//
// The 19 barrel exports (features/prospect/index.ts) plus the 8 internals that carry real UI of their own
// — RecordDetail and the reveal surfaces especially, which QuickViewDrawer and the grid hand off to.
//
// RevealStoreProvider is exported for previews to compose reveal-aware components inside, and is excluded
// from the card list via componentSrcMap in .design-sync/config.json — it is context plumbing, not a
// component anyone designs with.

export { AccountDetailDrawer } from "../../apps/web/src/features/prospect/components/AccountDetailDrawer";
export { AccountFilterPanel } from "../../apps/web/src/features/prospect/components/AccountFilterPanel";
export { AccountsTable } from "../../apps/web/src/features/prospect/components/AccountsTable";
export { AddToListDialog } from "../../apps/web/src/features/prospect/components/AddToListDialog";
export { AiSearchBox } from "../../apps/web/src/features/prospect/components/AiSearchBox";
export { BulkActionBar } from "../../apps/web/src/features/prospect/components/BulkActionBar";
export { BulkRevealDialog } from "../../apps/web/src/features/prospect/components/BulkRevealDialog";
export { BulkRevealJobDialog } from "../../apps/web/src/features/prospect/components/BulkRevealJobDialog";
export { CopyButton } from "../../apps/web/src/features/prospect/components/CopyButton";
export { FacetTypeahead } from "../../apps/web/src/features/prospect/components/FacetTypeahead";
export { FilterPanel } from "../../apps/web/src/features/prospect/components/FilterPanel";
export { FilterRail } from "../../apps/web/src/features/prospect/components/FilterRail";
export { ParsedFilterPreview } from "../../apps/web/src/features/prospect/components/ParsedFilterPreview";
export { ProspectPage } from "../../apps/web/src/features/prospect/components/ProspectPage";
export { ProspectToolbar } from "../../apps/web/src/features/prospect/components/ProspectToolbar";
export { QuickViewDrawer } from "../../apps/web/src/features/prospect/components/QuickViewDrawer";
export { RecentSearches } from "../../apps/web/src/features/prospect/components/RecentSearches";
export { RecomputeScoreButton } from "../../apps/web/src/features/prospect/components/RecomputeScoreButton";
export { RecordDetail } from "../../apps/web/src/features/prospect/components/RecordDetail";
export { RevealCell } from "../../apps/web/src/features/prospect/components/RevealCell";
export { RevealDialog } from "../../apps/web/src/features/prospect/components/RevealDialog";
export { RowActions } from "../../apps/web/src/features/prospect/components/RowActions";
export { SaveSearchPanel } from "../../apps/web/src/features/prospect/components/SaveSearchPanel";
export { StageManagementPanel } from "../../apps/web/src/features/prospect/components/StageManagementPanel";
export { StageSelector } from "../../apps/web/src/features/prospect/components/StageSelector";
export { TagChip } from "../../apps/web/src/features/prospect/components/TagChip";
export { TagPicker } from "../../apps/web/src/features/prospect/components/TagPicker";

// Context plumbing the reveal-aware components read. RevealStoreProvider is carded out via
// componentSrcMap; useRevealStore is camelCase, so it is never a component candidate. Previews need both:
// the provider to mount the store, and the hook to bulk-hydrate owned reveal data the way ProspectPage
// does on load — without that a standalone RevealCell can only render the coarse "Revealed" badge.
export { RevealStoreProvider, useRevealStore } from "../../apps/web/src/features/prospect/hooks/useRevealStore";
