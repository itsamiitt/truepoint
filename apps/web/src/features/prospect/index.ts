// Public surface of the prospect feature slice — the page component the (shell)/prospect route renders.
export { ProspectPage } from "./components/ProspectPage";

// Advanced search/filter (24, ADR-0035): server-driven typeahead filter rail + search hooks/client.
// Wire <FilterRail onChange={setFilters}/> + useContactSearch() into ProspectPage's left rail + grid.
export { FilterRail } from "./components/FilterRail";
export { FacetTypeahead } from "./components/FacetTypeahead";
export { useContactSearch } from "./hooks/useContactSearch";
export { useTypeahead } from "./hooks/useTypeahead";
export { searchContacts, suggestField, fetchFacetCounts } from "./searchApi";

// Pipeline stages (G-REV-7, ADR-0028): the workspace stage-management panel + the record StageSelector, plus
// the stage hook/client. Mount <StageManagementPanel/> in pipeline settings; <StageSelector/> lives on RecordDetail.
export { StageManagementPanel } from "./components/StageManagementPanel";
export { StageSelector } from "./components/StageSelector";
export { useStages } from "./hooks/useStages";
export { fetchStages, createStage, updateStage, assignStage } from "./stagesApi";
// Saved searches / segments (M8, 24 §8): "Save search" + the apply/rename/delete list for the rail. Wire
// <SaveSearchPanel currentQuery={…} onApply={(f) => { setText(f.text ?? ""); setFilters(f.filters); }}/>
// into ProspectPage's left rail; the panel re-runs the search via useContactSearch on apply.
export { SaveSearchPanel } from "./components/SaveSearchPanel";
export { useSavedSearches } from "./hooks/useSavedSearches";
export {
  listSavedSearches,
  createSavedSearch,
  updateSavedSearch,
  deleteSavedSearch,
} from "./savedSearchApi";
export { searchContacts, suggestField, fetchFacetCounts, aiSearch } from "./searchApi";

// AI NL→search (23, ADR-0023): the natural-language box + the validated-filter preview. The box compiles
// NL → a validated contactQuery and applies it on confirm via useContactSearch (human-in-the-loop).
export { AiSearchBox } from "./components/AiSearchBox";
export { ParsedFilterPreview } from "./components/ParsedFilterPreview";
// Record-customization tag layer (ADR-0028, G-REV-6): tag chip + picker (RecordDetail) + the workspace-tag
// + tagged-records hooks the filter rail uses.
export { TagChip } from "./components/TagChip";
export { TagPicker } from "./components/TagPicker";
export { useTags, useTaggedIds } from "./hooks/useTags";
