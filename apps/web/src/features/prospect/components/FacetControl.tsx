// FacetControl.tsx — renders ONE facet definition as its control: a term facet (typeahead or a fixed-option
// inline checkbox list, with the progressive-exclude block), a three-way boolean, or a min/max range. Every
// control sits in a closed-by-default FacetDisclosure. Shared by the quick tier and the "All filters"
// accordions so a facet looks identical wherever it sits. Presentation only — the pure helpers in
// ../filterGroups read and write the query.
//
// Every control carries its own scope mark (FacetScopeBadge — nothing for a `both` facet), so "this filter
// searches one side only" is visible BEFORE the click rather than only in the notice above the grid after.
"use client";

import type { ContactQuery } from "@leadwolf/types";
import type { ReactNode } from "react";
import {
  type FacetDef,
  type TermOp,
  addTermCondition,
  removeTermCondition,
  termConditions,
} from "../filterGroups";
import { BoolControl } from "./FacetBoolControl";
import { RangeControl } from "./FacetRangeControl";
import { FacetScopeBadge } from "./FacetScopeBadge";
import { FacetTypeahead } from "./FacetTypeahead";
import { TermFacetField } from "./TermFacetField";
import { TermOptionList } from "./TermOptionList";

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
  const scopeNote = <FacetScopeBadge scope={facet.scope} />;
  if (facet.kind === "bool")
    return (
      <BoolControl
        field={facet.field}
        label={facet.label}
        query={query}
        onChange={onChange}
        scopeNote={scopeNote}
      />
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
        scopeNote={scopeNote}
      />
    );
  return (
    <TermFacet
      facet={facet}
      query={query}
      onChange={onChange}
      counts={counts}
      owners={owners}
      scopeNote={scopeNote}
    />
  );
}

// ── term facet: progressive exclude (include by default; exclusion opens into its own block) ─────────────
function TermFacet({
  facet,
  query,
  onChange,
  counts,
  owners,
  scopeNote,
}: {
  facet: Extract<FacetDef, { kind: "term" }>;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  counts?: Map<string, number>;
  owners: OwnerOption[];
  scopeNote: ReactNode;
}) {
  const conditions = termConditions(query, facet.field);
  const applied = new Set(conditions.map((c) => c.value));
  // The FULL option list — the checkbox list carries applied state as checkmarks. Checking a value applied
  // in the other direction moves it there (addTermCondition keeps a value single-typed, never duplicated).
  const options = facet.input === "owner" ? owners : (facet.options ?? []);
  const valuesFor = (op: TermOp) => conditions.filter((c) => c.op === op).map((c) => c.value);
  const add = (op: TermOp, value: string) =>
    onChange(addTermCondition(query, facet.field, op, value));

  return (
    <TermFacetField
      label={facet.label}
      conditions={conditions}
      excludeNoun="Contacts"
      scopeNote={scopeNote}
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
            // A database-only facet's values live in the Layer-0 satellites, which the workspace suggest
            // endpoint cannot see — it must ask the global one or the picker silently returns nothing.
            source={facet.scope === "database-only" ? "database" : "workspace"}
            onAdd={(v) => add(op, v)}
          />
        ) : (
          <TermOptionList
            field={facet.field}
            label={facet.label}
            options={options}
            op={op}
            counts={counts}
            selected={valuesFor(op)}
            onToggle={(v) =>
              valuesFor(op).includes(v)
                ? onChange(removeTermCondition(query, facet.field, op, v))
                : add(op, v)
            }
          />
        )
      }
    />
  );
}
