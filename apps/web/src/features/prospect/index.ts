// Public surface of the prospect feature slice — the page component the (shell)/prospect route renders.
export { ProspectPage } from "./components/ProspectPage";

// Advanced search/filter (24, ADR-0035): server-driven typeahead filter rail + search hooks/client.
// Wire <FilterRail onChange={setFilters}/> + useContactSearch() into ProspectPage's left rail + grid.
export { FilterRail } from "./components/FilterRail";
export { FacetTypeahead } from "./components/FacetTypeahead";
export { useContactSearch } from "./hooks/useContactSearch";
export { useTypeahead } from "./hooks/useTypeahead";
export { searchContacts, suggestField, fetchFacetCounts, aiSearch } from "./searchApi";

// AI NL→search (23, ADR-0023): the natural-language box + the validated-filter preview. The box compiles
// NL → a validated contactQuery and applies it on confirm via useContactSearch (human-in-the-loop).
export { AiSearchBox } from "./components/AiSearchBox";
export { ParsedFilterPreview } from "./components/ParsedFilterPreview";
