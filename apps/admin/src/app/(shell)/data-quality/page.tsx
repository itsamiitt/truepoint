// data-quality/page.tsx — the thin App Router route for the Data-quality cockpit. Behavior lives in the feature
// slice (features/data-quality); this file only mounts its public component inside the (shell) chrome.
import { DataQualityPage } from "@/features/data-quality";

export default function Page() {
  return <DataQualityPage />;
}
