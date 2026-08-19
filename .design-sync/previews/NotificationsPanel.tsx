// NotificationsPanel - Settings ▸ User ▸ Notifications (12 §2): a grid of TpSwitch toggles for the four events (reply / task / low-credit / digest) across the in-app + email channels, saved via PUT /settings/user/notifications.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { NotificationsPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** NotificationsPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <NotificationsPanel />
  </Page>
);
