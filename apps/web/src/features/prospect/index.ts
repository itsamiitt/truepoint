// Public surface of the prospect feature slice — the People pane the /search route mounts, plus the
// shared masked-grid/bulk/typeahead surface other features reuse through this barrel.
export { PeoplePane } from "./components/PeoplePane";

// Prospect-search redesign (24): the results toolbar (sort + column chooser), the lightweight QuickView
// preview Drawer, the per-row overflow menu, and the per-browser Recent-searches row. PeoplePane composes
// these; they're exported for reuse/testing and to keep the slice surface explicit.
export { ProspectToolbar } from "./components/ProspectToolbar";
export { QuickViewDrawer } from "./components/QuickViewDrawer";
export { RowActions } from "./components/RowActions";
export { RecentSearches } from "./components/RecentSearches";
export { useRecentSearches, type RecentSearch } from "./hooks/useRecentSearches";

// Shared bulk surface + masked-grid helpers (24, Phase-3). Exported so OTHER masked-contact surfaces (e.g. the
// Lists members grid) can reuse the sticky bulk bar, the selection model, the masked "add to list" picker, and
// the masking presentation helpers through this PUBLIC barrel — never by deep-importing the slice internals
// (no-cross-feature-import). The dependency is one-way (lists → prospect): prospect imports nothing from lists.
export { BulkActionBar, type RowBulkAction } from "./components/BulkActionBar";
export { AddToListDialog } from "./components/AddToListDialog";
export {
  type BulkSelectionStore,
  type ProspectBulkSelection,
  useBulkSelection,
  useBulkSelectionStore,
} from "./hooks/useBulkSelection";
export { RowSelectCheckbox, SelectAllCheckbox } from "./components/SelectionControls";
export { displayName, emailGlyphFor, maskedEmail } from "./types";
// The bulk enrich/re-verify + the D5 pre-flight estimate clients — reused by the Lists members surface for its
// own "Re-verify" affordance (list-plan/06 §3.4, §5) so it drives the SAME contacts-bulk backend, not a fork.
export { bulkEnrich, bulkEstimate } from "./bulkActionsApi";

// Advanced search/filter (24, ADR-0035): server-driven typeahead filter rail + search hooks/client.
// Wire useProspectSearch() into PeoplePane's grid; FilterPanel renders FILTER_GROUPS inside the shell drawer.

export { FacetTypeahead } from "./components/FacetTypeahead";
export { useTypeahead } from "./hooks/useTypeahead";

// Pipeline stages (G-REV-7, ADR-0028): the workspace stage-management panel + the record StageSelector, plus
// the stage hook/client. Mount <StageManagementPanel/> in pipeline settings; <StageSelector/> lives on RecordDetail.
export { StageManagementPanel } from "./components/StageManagementPanel";
export { StageSelector } from "./components/StageSelector";
export { useStages } from "./hooks/useStages";
export { fetchStages, createStage, updateStage, assignStage } from "./stagesApi";
// Saved searches / segments (M8, 24 §8): "Save search" + the apply/rename/delete list for the rail. Wire
// <SaveSearchPanel currentQuery={…} onApply={(f) => { setText(f.text ?? ""); setFilters(f.filters); }}/>
// into PeoplePane's filter rail; the panel re-runs the search via useProspectSearch on apply.
export { SaveSearchPanel } from "./components/SaveSearchPanel";
export { useSavedSearches } from "./hooks/useSavedSearches";
export {
  listSavedSearches,
  createSavedSearch,
  updateSavedSearch,
  deleteSavedSearch,
} from "./savedSearchApi";
export { searchContacts, suggestField, fetchFacetCounts, aiSearch } from "./searchApi";

// Company-level (accounts) search (24, ADR-0035): the firmographic sibling of the Contacts surface. AccountsPane
// renders these under the "Accounts" scope (filter rail + results grid + read-only detail drawer), driven by
// useAccountSearch + useAccountFacetCounts against the real /account-search API. Exported for reuse/testing.
export { AccountFilterPanel } from "./components/AccountFilterPanel";
export { AccountsTable } from "./components/AccountsTable";
export { useAccountSearch } from "./hooks/useAccountSearch";
export { useAccountFacetCounts } from "./hooks/useAccountFacetCounts";
export {
  searchAccounts,
  fetchAccountFacetCounts,
  suggestAccountField,
  countAccounts,
} from "./accountSearchApi";

// AI NL→search (23, ADR-0023): the natural-language box + the validated-filter preview. The box compiles
// NL → a validated contactQuery and applies it on confirm via useProspectSearch (human-in-the-loop).
export { AiSearchBox } from "./components/AiSearchBox";
export { ParsedFilterPreview } from "./components/ParsedFilterPreview";
// Record-customization tag layer (ADR-0028, G-REV-6): tag chip + picker (RecordDetail) + the workspace-tag
// + tagged-records hooks the filter rail uses.
export { TagChip } from "./components/TagChip";
export { TagPicker } from "./components/TagPicker";
export { useTags, useTaggedIds } from "./hooks/useTags";
// Account-intelligence sections (market-intelligence MI-1): exported so the /companies/:id page composes
// the SAME sections the drawer shows — one implementation, two surfaces, no drift.
export { HeadcountSection } from "./components/HeadcountSection";
export { AccountTechnologySection } from "./components/AccountTechnologySections";
export {
  AccountAlumniSection,
  AccountDisplacementSection,
} from "./components/AccountGraphSections";
// Deep-link builder for "view this company's contacts" from non-prospect surfaces (companies page).
export { contactsHrefForCompany } from "./searchUrlState";
// org-kind-aware copy + the shared-cache orgKind read: the /companies/:id header renders "Institution"
// for a school instead of calling everything a company (the retired drawer's nicety, kept alive).
export { orgKindCopy, isNotableOrgKind } from "./orgKindCopy";
export { useAccountTechnologies } from "./hooks/useAccountTechnologies";
// The slice's typed API error. Exported so features/accounts can throw the SAME error type its sibling
// surface does rather than minting a fourth copy of the class (there are already three in apps/web —
// prospect, lists, sequences). FOLLOW-UP: collapse all of them into apps/web/src/lib/, the way
// `problemMessage` was consolidated by audit 32 · F4; this export is the interim, not the destination.
export { ApiError } from "./api";
