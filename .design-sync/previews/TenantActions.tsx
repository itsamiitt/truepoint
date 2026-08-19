// TenantActions — the suspend / reactivate controls on a tenant row. Every action is audited and asks for a
// reason, because "why was this tenant suspended" is the first question anyone asks afterwards.
//
// The variant axis is the tenant's status, which decides which action is even offered — and a dunning
// suspension is not the same as a staff one.
import { TenantActions } from "@leadwolf/ui";
import { AdminFrame, TENANTS } from "./_adminFixtures";

/** Active: suspend is the available action. */
export const Active = () => (
  <AdminFrame>
    <TenantActions tenant={TENANTS[0]} onChanged={() => {}} />
  </AdminFrame>
);

/** Suspended for non-payment — reactivation is a billing decision, not just a click. */
export const SuspendedDunning = () => (
  <AdminFrame>
    <TenantActions tenant={TENANTS[2]} onChanged={() => {}} />
  </AdminFrame>
);

/** Suspended by a staff member. */
export const SuspendedByStaff = () => (
  <AdminFrame>
    <TenantActions tenant={TENANTS[6]} onChanged={() => {}} />
  </AdminFrame>
);
