// EntityPicker - the generic typeahead that TenantPicker and UserPicker are both built on. The caller
// supplies the `search` function, which is what makes it reusable across entity kinds.
//
// The search below resolves from a local list rather than the network: this cell documents the COMPONENT,
// not a particular endpoint, and a card should not depend on which route happens to be fixtured.
import { EntityPicker } from "@leadwolf/ui";
import { AdminFrame } from "./_adminFixtures";

const OPTIONS = [
  { value: "00000000-0000-4000-8000-000000000101", label: "Northwind Logistics" },
  { value: "00000000-0000-4000-8000-000000000102", label: "Halcyon MedTech" },
  { value: "00000000-0000-4000-8000-000000000105", label: "Ironbridge Group" },
];

const search = async (q: string) =>
  OPTIONS.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));

/** Resting, with a caller-supplied search. */
export const Empty = () => (
  <AdminFrame>
    <EntityPicker value="" onChange={() => {}} search={search} />
  </AdminFrame>
);

/** A selection made, with the label the caller handed back. */
export const Selected = () => (
  <AdminFrame>
    <EntityPicker
      value="00000000-0000-4000-8000-000000000105"
      selectedLabel="Ironbridge Group"
      onChange={() => {}}
      search={search}
    />
  </AdminFrame>
);

/** Disabled. */
export const Disabled = () => (
  <AdminFrame>
    <EntityPicker value="" onChange={() => {}} search={search} disabled />
  </AdminFrame>
);
