// ai-usage/page.tsx — the thin App Router route for the AI-usage cockpit. Behavior lives in the feature slice
// (features/ai-usage); this file only mounts its public component inside the (shell) chrome.
import { AiUsagePage } from "@/features/ai-usage";

export default function Page() {
  return <AiUsagePage />;
}
