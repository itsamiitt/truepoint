// UserPicker - the platform-user typeahead, used for staff grants and user-scoped actions.
import { UserPicker } from "@leadwolf/ui";
import { AdminFrame } from "./_adminFixtures";

/** Nothing chosen yet. */
export const Empty = () => (
  <AdminFrame>
    <UserPicker value="" onChange={() => {}} placeholder="Search users..." />
  </AdminFrame>
);

/** A user already selected, shown by the email staff actually recognise. */
export const Selected = () => (
  <AdminFrame>
    <UserPicker
      value="00000000-0000-4000-8000-000000000301"
      selectedLabel="priya.raghavan@northwind.example"
      onChange={() => {}}
    />
  </AdminFrame>
);

/** Disabled while the action it scopes is running. */
export const Disabled = () => (
  <AdminFrame>
    <UserPicker
      value="00000000-0000-4000-8000-000000000301"
      selectedLabel="priya.raghavan@northwind.example"
      onChange={() => {}}
      disabled
    />
  </AdminFrame>
);
