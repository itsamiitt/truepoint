// TagPicker — assign/unassign workspace tags on one record, and create a new tag inline (ADR-0028).
// `assigned` is owned by the parent and updated through a functional updater so concurrent
// assign/unassign/create mutations compose instead of clobbering each other.
import { TagPicker } from "@leadwolf/ui";
import { useState } from "react";
import { ASSIGNED_TAGS, CONTACTS } from "../prospect/fixtures";
import { Shell, pad, useOpenMenu } from "./_prospectShell";

const isEdit = (b: HTMLButtonElement) => /edit|add tag/i.test(b.textContent ?? "");

/** Two tags already on the record — the state a detail panel usually opens in. */
export const Assigned = () => {
  const [tags, setTags] = useState(ASSIGNED_TAGS);
  return (
    <Shell>
      <div style={pad}>
        <TagPicker recordId={CONTACTS[0].id} assigned={tags} onChange={setTags} />
      </div>
    </Shell>
  );
};

/** The picker itself, forced open: the workspace tag list with the assigned ones marked, plus the inline
 *  "create a new tag" affordance. This is the component's substance and it is only reachable via Edit. */
export const Picking = () => {
  const [tags, setTags] = useState(ASSIGNED_TAGS);
  const ref = useOpenMenu<HTMLDivElement>(isEdit);
  return (
    <Shell>
      <div ref={ref} style={{ ...pad, paddingBottom: 300 }}>
        <TagPicker recordId={CONTACTS[0].id} assigned={tags} onChange={setTags} />
      </div>
    </Shell>
  );
};

/** An untagged record: the picker collapses to its add affordance. */
export const Untagged = () => {
  const [tags, setTags] = useState<typeof ASSIGNED_TAGS>([]);
  return (
    <Shell>
      <div style={pad}>
        <TagPicker recordId={CONTACTS[3].id} assigned={tags} onChange={setTags} />
      </div>
    </Shell>
  );
};
