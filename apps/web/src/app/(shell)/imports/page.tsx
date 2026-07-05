// (shell)/imports/page.tsx — the Imports section route: the durable import history dashboard (import-redesign
// 11 §2, S-U2). All rendering lives in the feature slice; this file just mounts it inside the app shell. When
// the IMPORT_V2 dual gate is off the list endpoint 404s and the page shows an honest "not enabled yet" state.
import { ImportJobsHistoryPage } from "@/features/import";

export default function Page() {
  return <ImportJobsHistoryPage />;
}
