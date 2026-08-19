// ReverifyNowButton - the owner/admin-only "Re-verify now" trigger on the Data health re-verification tab.
//
// `canTrigger` is a HARD render gate, not a disabled state: the component returns null for anyone without the
// role, so a non-admin sees no affordance at all. That is defence in depth rather than the whole defence -
// the endpoint enforces requireRole independently, because a UI gate is not a permission.
//
// One story: the false branch renders nothing, and the confirm Dialog behind the button opens on local state
// a card cannot drive. The dialog states the honest cost - it re-checks already-revealed, past-SLA contacts
// and spends NO reveal credits.
import { ReverifyNowButton } from "@leadwolf/ui";
import { Frame } from "./_webPage";

/** An owner or admin: the trigger renders, and clicking it opens the confirm rather than firing. */
export const Available = () => (
  <Frame>
    <ReverifyNowButton canTrigger onQueued={() => {}} />
  </Frame>
);
