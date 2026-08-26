// FacetBoolControl.tsx — a three-way boolean facet (Any / Yes / No) as a compact toggle row. Presentation
// only; the pure helpers in ../filterGroups read and write the query.
"use client";

import type { BoolFilterField, ContactQuery } from "@leadwolf/types";
import type { ReactNode } from "react";
import { getBool, setBool } from "../filterGroups";
import styles from "../prospect.module.css";

export function MiniToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={styles.miniToggle}
      data-active={active ? "true" : undefined}
    >
      {children}
    </button>
  );
}

export function BoolControl({
  field,
  label,
  query,
  onChange,
}: {
  field: BoolFilterField;
  label: string;
  query: ContactQuery;
  onChange: (q: ContactQuery) => void;
}) {
  const current = getBool(query, field);
  const opt = (value: boolean | undefined, text: string) => (
    <MiniToggle active={current === value} onClick={() => onChange(setBool(query, field, value))}>
      {text}
    </MiniToggle>
  );
  return (
    <div className={styles.facetRow}>
      <span className={styles.facetLabel}>{label}</span>
      <span className={styles.opToggle}>
        {opt(undefined, "Any")}
        {opt(true, "Yes")}
        {opt(false, "No")}
      </span>
    </div>
  );
}
