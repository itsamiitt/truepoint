// (shell)/inbox/page.tsx — the Inbox destination. Thin route file: mounts the inbox slice (unified replies +
// tasks). Reply/task ingestion is the M9 mailbox-sync gate, so the surfaces render first-class empty states
// until a backend is connected (no fabricated data).
import { InboxPage } from "@/features/inbox";

export default function InboxRoute() {
  return <InboxPage />;
}
