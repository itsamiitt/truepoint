// WebhooksPanel - Developer ▸ Webhooks: subscribe to outbound events (reveal.completed / score.updated / outreach.status_changed / auth.event) with a signing secret shown once, a list of subscriptions, and a delivery-log DataTable (09 §10 — delivery log + retries).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { WebhooksPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** WebhooksPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <WebhooksPanel />
  </Page>
);
