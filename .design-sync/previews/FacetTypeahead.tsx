// FacetTypeahead — the server-backed value picker for one facet (24 §3.3). Debounced prefix queries hit
// /search/suggest and come back with a match count per value; picking one adds it to the facet's clause.
// It is a picker only: the facet label and the applied chips belong to TermFacetField, and one instance
// serves each direction of the progressive-exclude pattern (`op`).
import { FacetTypeahead } from "@leadwolf/ui";
import { useState } from "react";
import { Shell } from "./_prospectShell";

const box: React.CSSProperties = { width: 264, background: "var(--tp-surface)", padding: 12 };
const label: React.CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontSize: 12,
  fontWeight: 600,
  color: "var(--tp-ink-2)",
};

/** The include direction: picks land in the positive clause; values already applied are never re-suggested. */
export const Include = () => {
  const [selected, setSelected] = useState(["VP of Engineering", "VP of Product"]);
  return (
    <Shell>
      <div style={box}>
        <span style={label}>Job title</span>
        <FacetTypeahead
          field="title"
          label="Job title"
          selected={selected}
          onAdd={(v) => setSelected((s) => (s.includes(v) ? s : [...s, v]))}
        />
      </div>
    </Shell>
  );
};

/** The exclude direction: same picker, negative placeholder — it renders inside the exclusion block. */
export const Exclude = () => (
  <Shell>
    <div style={{ ...box, background: "var(--danger-tint)" }}>
      <span style={{ ...label, color: "var(--danger-700)" }}>Exclude</span>
      <FacetTypeahead
        field="industry"
        label="Industry"
        op="exclude"
        selected={["Staffing & Recruiting"]}
        onAdd={() => {}}
      />
    </div>
  </Shell>
);

/** The resting state: prompt only, nothing applied yet. */
export const Empty = () => (
  <Shell>
    <div style={box}>
      <span style={label}>Company</span>
      <FacetTypeahead field="company" label="Company" selected={[]} onAdd={() => {}} />
    </div>
  </Shell>
);
