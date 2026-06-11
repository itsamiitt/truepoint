// home/page.tsx — the thin App Router route for the Home cockpit. All behavior lives in the feature slice
// (features/home); this file only mounts its public component inside the (shell) chrome.
import { HomePage } from "@/features/home";

export default function Page() {
  return <HomePage />;
}
