// AuthEnforcementCard — the tenant-level auth-enforcement switch. Lockout-capable, so it is gated on the
// super_admin role, and the API re-checks that role on the write itself: the render gate here is UX only,
// never the security boundary.
import { AuthEnforcementCard } from "@leadwolf/ui";
import { AdminFrame, TENANT_DETAIL } from "./_adminFixtures";

/** Enforcement on, for an active tenant. */
export const Enforced = () => (
  <AdminFrame>
    <AuthEnforcementCard detail={TENANT_DETAIL} onChanged={() => {}} />
  </AdminFrame>
);

/** Enforcement off — the state a tenant sits in before an admin turns it on. */
export const NotEnforced = () => (
  <AdminFrame>
    <AuthEnforcementCard
      detail={{ ...TENANT_DETAIL, enforcementEnabled: false }}
      onChanged={() => {}}
    />
  </AdminFrame>
);
