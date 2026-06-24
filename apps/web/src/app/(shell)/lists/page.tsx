// lists/page.tsx — the thin App Router route for the Lists index surface. All behavior lives in the feature
// slice (features/lists); this file only mounts its public component inside the (shell) chrome.
import { ListsPage } from "@/features/lists";

// The Lists surface fetches its data client-side (in-memory token, ADR-0016), so it renders dynamically rather
// than being statically prerendered.
export const dynamic = "force-dynamic";

export default function ListsRoute() {
  return <ListsPage />;
}
