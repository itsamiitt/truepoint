// FacetBoolControl.tsx — a three-way boolean facet (Any / Yes / No) behind a closed-by-default
// FacetDisclosure, as a compact segmented row. The DS SegmentedControl rather than hand-rolled pills: it
// carries the selected state to assistive tech and the keyboard model itself, which the raw `MiniToggle`
// buttons this replaced did not (UI remediation 2026-08-22 retired that class). Presentation only; the pure
// helpers in ../filterGroups read and write the query.
"use client";

import type { BoolFilterField, ContactQuery } from "@leadwolf/types";
import { SegmentedControl } from "@leadwolf/ui";
import type { ReactNode } from "react";
import { getBool, setBool } from "../filterGroups";
import { FacetDisclosure } from "./FacetDisclosure";

const ITEMS = [
  { value: "any", label: "Any" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

const toValue = (b: boolean | undefined): string => (b === undefined ? "any" : b ? "yes" : "no");
const fromValue = (v: string): boolean | undefined => (v === "any" ? undefined : v === "yes");

export function BoolControl({
  field,
  label,
  query,
  onChange,
  scopeNote,
}: {
  field: BoolFilterField;
  label: string;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  /** Optional mark beside the label — the scope badge. */
  scopeNote?: ReactNode;
}) {
  const current = getBool(query, field);
  return (
    <FacetDisclosure
      label={label}
      summary={current === undefined ? undefined : current ? "Yes" : "No"}
      scopeNote={scopeNote}
    >
      <SegmentedControl
        items={ITEMS}
        value={toValue(current)}
        onChange={(v) => onChange(setBool(query, field, fromValue(v)))}
        aria-label={label}
      />
    </FacetDisclosure>
  );
}
