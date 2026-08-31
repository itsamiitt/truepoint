// FacetRangeControl.tsx — a min/max range facet (number or date) behind a closed-by-default
// FacetDisclosure. Keystrokes land in a draft and commit after a quiet 400ms or on blur: the query is the
// cache key for search + facets + count + database, so committing per keystroke fired 4–5 requests per
// character typed.
"use client";

import type { ContactQuery } from "@leadwolf/types";
import { TpInput } from "@leadwolf/ui";
import type { ReactNode } from "react";
import { getRange, setRange } from "../filterGroups";
import { useDraftRange } from "../hooks/useDraftRange";
import styles from "../prospect.module.css";
import { FacetDisclosure } from "./FacetDisclosure";

/** epoch-ms → <input type=date> value (YYYY-MM-DD, UTC). */
function msToDateInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
/** <input type=date> value → epoch-ms at UTC midnight. */
function dateInputToMs(s: string): number {
  return new Date(`${s}T00:00:00.000Z`).getTime();
}

export function RangeControl({
  field,
  label,
  valueKind,
  unit,
  query,
  onChange,
  scopeNote,
}: {
  field: string;
  label: string;
  valueKind: "number" | "date";
  unit?: string;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
  /** Optional mark beside the label — the scope badge. */
  scopeNote?: ReactNode;
}) {
  const { gte, lte } = getRange(query, field);
  const { draft, schedule, flush } = useDraftRange(gte, lte, (next) =>
    onChange(setRange(query, field, next.gte, next.lte)),
  );
  const toInput = (n: number | undefined) =>
    n === undefined ? "" : valueKind === "date" ? msToDateInput(n) : String(n);
  const fromInput = (s: string): number | undefined => {
    if (!s) return undefined;
    return valueKind === "date" ? dateInputToMs(s) : Number(s);
  };
  const type = valueKind === "date" ? "date" : "number";
  return (
    <FacetDisclosure
      label={unit ? `${label} (${unit})` : label}
      badge={gte !== undefined || lte !== undefined ? 1 : undefined}
      scopeNote={scopeNote}
    >
      <div className={styles.rangeRow}>
        <TpInput
          type={type}
          placeholder="Min"
          aria-label={`${label} minimum`}
          value={toInput(draft.gte)}
          onChange={(e) => schedule({ gte: fromInput(e.target.value), lte: draft.lte })}
          onBlur={flush}
        />
        <TpInput
          type={type}
          placeholder="Max"
          aria-label={`${label} maximum`}
          value={toInput(draft.lte)}
          onChange={(e) => schedule({ gte: draft.gte, lte: fromInput(e.target.value) })}
          onBlur={flush}
        />
      </div>
    </FacetDisclosure>
  );
}
