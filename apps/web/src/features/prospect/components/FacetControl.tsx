// FacetControl.tsx — renders ONE facet definition as its control: a term facet (typeahead or fixed-option
// chips, with the progressive-exclude block), a three-way boolean, or a min/max range. Shared by the quick
// tier and the "All filters" accordions so a facet looks identical wherever it sits. Presentation only —
// the pure helpers in ../filterGroups read and write the query.
"use client";

import type { ContactQuery } from "@leadwolf/types";
import {
  type FacetDef,
  type TermOp,
  addTermCondition,
  removeTermCondition,
  termConditions,
} from "../filterGroups";
import { BoolControl } from "./FacetBoolControl";
import { RangeControl } from "./FacetRangeControl";
import { FacetTypeahead } from "./FacetTypeahead";
import { TermFacetField } from "./TermFacetField";
import { TermOptionChips } from "./TermOptionChips";

export interface OwnerOption {
  value: string;
  label: string;
}

export function FacetControl({
  facet,
  query,
  onChange,
  counts,
  owners,
}: {
  facet: FacetDef;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  /** Live per-option counts keyed `${field}:${value}` (from POST /search/facets). Optional. */
  counts?: Map<string, number>;
  /** Teammates (+ a "Me" entry the page prepends) for the Owner facet. */
  owners: OwnerOption[];
}) {
  if (facet.kind === "bool")
    return (
      <BoolControl field={facet.field} label={facet.label} query={query} onChange={onChange} />
    );
  if (facet.kind === "range")
    return (
      <RangeControl
        field={facet.field}
        label={facet.label}
        valueKind={facet.valueKind}
        unit={facet.unit}
        query={query}
        onChange={onChange}
      />
    );
  return (
    <TermFacet facet={facet} query={query} onChange={onChange} counts={counts} owners={owners} />
  );
}

// ── term facet: progressive exclude (include by default; exclusion opens into its own block) ─────────────
function TermFacet({
  facet,
  query,
  onChange,
  counts,
  owners,
}: {
  facet: Extract<FacetDef, { kind: "term" }>;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  counts?: Map<string, number>;
  owners: OwnerOption[];
}) {
  const conditions = termConditions(query, facet.field);
  const applied = new Set(conditions.map((c) => c.value));
  // A value applied in EITHER direction is never offered again — it can never be both included and excluded.
  const options = (facet.input === "owner" ? owners : (facet.options ?? [])).filter(
    (o) => !applied.has(o.value),
  );
  const add = (op: TermOp, value: string) =>
    onChange(addTermCondition(query, facet.field, op, value));

  return (
    <TermFacetField
      label={facet.label}
      conditions={conditions}
      excludeNoun="Contacts"
      onRemove={(op, value) => onChange(removeTermCondition(query, facet.field, op, value))}
      renderPicker={(op, autoFocus) =>
        facet.input === "typeahead" ? (
          <FacetTypeahead
            field={facet.field}
            label={facet.label}
            op={op}
            autoFocus={autoFocus}
            selected={[...applied]}
            placeholder={facet.placeholder}
            onAdd={(v) => add(op, v)}
          />
        ) : (
          <TermOptionChips
            field={facet.field}
            options={options}
            op={op}
            counts={counts}
            anyApplied={applied.size > 0}
            onAdd={(v) => add(op, v)}
          />
        )
      }
    />
  );
}
