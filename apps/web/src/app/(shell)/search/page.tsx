// (shell)/search/page.tsx — the Search destination (search-consolidation). Thin App Router route: all
// behavior lives in the feature slice (features/search), which owns the tab + drawer state and mounts one
// pane. Replaces /prospect, and absorbs the retired /companies index as the Accounts tab.
import { SearchSurface } from "@/features/search";

// The surface reads its tab and both panes' filter state from the URL (useSearchParams), so it is rendered
// dynamically rather than statically prerendered (avoids the prerender CSR bailout).
export const dynamic = "force-dynamic";

export default function SearchRoute() {
  return <SearchSurface />;
}
