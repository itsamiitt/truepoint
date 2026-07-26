// TagChip — the record-tag chip (ADR-0028). Three cells: the colour vocabulary, the filter-facet
// toggle state, and the removable form used inside TagPicker.
import { TagChip } from "@leadwolf/ui";

const row: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" };

/** Every tag colour the workspace can assign, with names a real workspace would use. */
export const Colors = () => (
  <div style={row}>
    <TagChip name="Champion" color="success" />
    <TagChip name="Q3 target" color="accent" />
    <TagChip name="Competitor user" color="warning" />
    <TagChip name="Do not contact" color="danger" />
    <TagChip name="Webinar attendee" color="info" />
    <TagChip name="Renewal risk" color="neutral" />
  </div>
);

/** As a filter facet in the rail: clicking toggles; `active` is the selected state. */
export const FilterFacets = () => (
  <div style={row}>
    <TagChip name="Champion" color="success" active onClick={() => {}} />
    <TagChip name="Q3 target" color="accent" onClick={() => {}} />
    <TagChip name="Webinar attendee" color="info" onClick={() => {}} />
  </div>
);

/** Assigned to a record: the trailing × unassigns without firing onClick. */
export const Removable = () => (
  <div style={row}>
    <TagChip name="Champion" color="success" onRemove={() => {}} />
    <TagChip name="Q3 target" color="accent" onRemove={() => {}} />
    <TagChip name="Renewal risk" color="neutral" onRemove={() => {}} />
  </div>
);
