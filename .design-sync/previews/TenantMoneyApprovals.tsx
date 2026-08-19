// TenantMoneyApprovals — credit adjustments awaiting a second staff decision. Money moves under the
// two-person rule, so the requester can never be the approver.
import { TenantMoneyApprovals } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** The approvals panel for a live tenant. */
export const Loaded = () => (
  <Page height={460}>
    <TenantMoneyApprovals
      tenantId="00000000-0000-4000-8000-000000000101"
      onDecided={() => {}}
    />
  </Page>
);
