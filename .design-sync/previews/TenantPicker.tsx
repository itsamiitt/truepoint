// TenantPicker - the tenant typeahead used wherever a staff action has to be scoped to one customer.
//
// It searches the real /admin/tenants route through the stubbed client, so typing filters live. The cells
// show the resting and pre-selected states; the open menu is keystroke-driven and cannot render statically.
import { TenantPicker } from "@leadwolf/ui";
import { AdminFrame } from "./_adminFixtures";

/** Nothing chosen yet. */
export const Empty = () => (
  <AdminFrame>
    <TenantPicker value="" onChange={() => {}} placeholder="Search tenants..." />
  </AdminFrame>
);

/** A tenant already selected - the label persists, so the choice survives a reload. */
export const Selected = () => (
  <AdminFrame>
    <TenantPicker
      value="00000000-0000-4000-8000-000000000101"
      selectedName="Northwind Logistics"
      onChange={() => {}}
    />
  </AdminFrame>
);

/** Disabled, as it appears while the scoped action is in flight. */
export const Disabled = () => (
  <AdminFrame>
    <TenantPicker
      value="00000000-0000-4000-8000-000000000101"
      selectedName="Northwind Logistics"
      onChange={() => {}}
      disabled
    />
  </AdminFrame>
);
