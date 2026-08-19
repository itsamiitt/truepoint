// MailboxesPage - the Email & mailboxes settings surface (M12, email-planning/13 P0): connect a mailbox, authenticate a sending domain, and see the per-tenant send quota.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { MailboxesPage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** MailboxesPage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <MailboxesPage />
  </Page>
);
