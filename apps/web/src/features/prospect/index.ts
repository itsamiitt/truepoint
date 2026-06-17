// Public surface of the prospect feature slice — the page component the (shell)/prospect route renders.
export { ProspectPage } from "./components/ProspectPage";

// Advanced search/filter (24, ADR-0035): server-driven typeahead filter rail + search hooks/client.
// Wire <FilterRail onChange={setFilters}/> + useContactSearch() into ProspectPage's left rail + grid.
export { FilterRail } from "./components/FilterRail";
export { FacetTypeahead } from "./components/FacetTypeahead";
export { useContactSearch } from "./hooks/useContactSearch";
export { useTypeahead } from "./hooks/useTypeahead";
export { searchContacts, suggestField, fetchFacetCounts } from "./searchApi";

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
