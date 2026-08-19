// PlanTab - the billing Plan tab: the tier, its seat and workspace caps, and what the plan unlocks.
import { PlanTab } from "@leadwolf/ui";
import * as D from "./_webData";
import { Frame } from "./_webPage";

/** A Team plan with 14 of 25 seats used. */
export const Team = () => (
  <Frame>
    <PlanTab plan={D.TENANT_PLAN} />
  </Frame>
);

/** Free: one seat, no grant, most features off. */
export const Free = () => (
  <Frame>
    <PlanTab
      plan={{
        tier: "free",
        planName: "Free",
        seatsUsed: 1,
        seatLimit: 1,
        workspacesUsed: 1,
        workspaceLimit: 1,
        balance: 0,
        features: { search: true, exports: false, crm_sync: false, api: false },
      }}
    />
  </Frame>
);

/** Unlimited workspaces - `workspaceLimit: null` must read as unlimited, not as zero. */
export const Unlimited = () => (
  <Frame>
    <PlanTab plan={{ ...D.TENANT_PLAN, tier: "enterprise", planName: "Enterprise", workspaceLimit: null, seatLimit: null }} />
  </Frame>
);

/** Plan not yet resolved. */
export const Unknown = () => (
  <Frame>
    <PlanTab plan={null} />
  </Frame>
);
