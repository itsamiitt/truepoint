// content/page.tsx — the thin App Router route for the announcements authoring surface. Behavior lives in the
// feature slice (features/content); this file only mounts its public component inside the (shell) chrome.
import { ContentPage } from "@/features/content";

export default function Page() {
  return <ContentPage />;
}
