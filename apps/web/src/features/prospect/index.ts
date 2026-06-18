// Public surface of the prospect feature slice — the page component the (shell)/prospect route renders.
export { ProspectPage } from "./components/ProspectPage";

// Advanced search/filter (24, ADR-0035): server-driven typeahead filter rail + search hooks/client.
// Wire <FilterRail onChange={setFilters}/> + useContactSearch() into ProspectPage's left rail + grid.
export { FilterRail } from "./components/FilterRail";
export { FacetTypeahead } from "./components/FacetTypeahead";
export { useContactSearch } from "./hooks/useContactSearch";
export { useTypeahead } from "./hooks/useTypeahead";
export { searchContacts, suggestField, fetchFacetCounts } from "./searchApi";

// Record-customization tag layer (ADR-0028, G-REV-6): tag chip + picker (RecordDetail) + the workspace-tag
// + tagged-records hooks the filter rail uses.
export { TagChip } from "./components/TagChip";
export { TagPicker } from "./components/TagPicker";
export { useTags, useTaggedIds } from "./hooks/useTags";
