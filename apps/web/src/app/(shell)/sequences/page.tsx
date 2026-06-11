// (shell)/sequences/page.tsx — the thin App Router route for the Sequences destination (11 §4.3). All
// behavior lives in the feature slice (features/sequences); this file only mounts its public component
// inside the (shell) chrome.
import { SequencesPage } from "@/features/sequences";

export default function SequencesRoute() {
  return <SequencesPage />;
}
