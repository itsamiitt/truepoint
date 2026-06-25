// (shell)/settings/mailboxes/page.tsx — the thin App Router route for Email & mailboxes (M12,
// email-planning/13 P0, 12 §4). All behavior lives in the feature slice (features/settings-mailboxes); this
// file only mounts its public component inside the (shell) chrome.
import { MailboxesPage } from "@/features/settings-mailboxes";

export default function MailboxesRoute() {
  return <MailboxesPage />;
}
