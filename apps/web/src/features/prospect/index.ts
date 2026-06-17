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
