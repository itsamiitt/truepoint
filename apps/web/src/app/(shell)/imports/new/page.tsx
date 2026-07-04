// (shell)/imports/new/page.tsx — thin route for the import wizard, now inside the (shell) chrome
// (import-redesign 11 §1.1 heals the /import-outside-the-shell split; S-U1 route scaffolding). Renders the
// shipped ImportPage unchanged; the five-step wizard v2 (11 §3, S-U4) replaces it here later.
import { ImportPage } from "@/features/import";

export default function Page() {
  return <ImportPage />;
}
