// (shell)/sales-navigator/page.tsx — the thin App Router route for the Sales Navigator destination (05 §5, M7).
// All behavior lives in the feature slice (features/sales-navigator); this file only mounts its public component
// inside the (shell) chrome.
import { SalesNavPage } from "@/features/sales-navigator";

export default function SalesNavigatorRoute() {
  return <SalesNavPage />;
}
