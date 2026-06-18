// ParsedFilterPreview.tsx — render the VALIDATED structured filter the AI produced (a contactQuery) in a
// plain, human-readable form so the user can confirm it before applying (23 §1/§3 human-in-the-loop). This
// is display-only: it shows the free-text, each term clause (include/exclude, grouped by facet), each numeric
// range, the sort, and the model's optional one-line summary. No PII, no results — just the filter shape.
"use client";

import type { AiSearchResponse, FilterClause } from "@leadwolf/types";
import { TpChip } from "@leadwolf/ui";

function isTerm(c: FilterClause): c is Extract<FilterClause, { kind: "term" }> {
  return c.kind === "term";
}
function isRange(c: FilterClause): c is Extract<FilterClause, { kind: "range" }> {
  return c.kind === "range";
}

function rangeLabel(c: Extract<FilterClause, { kind: "range" }>): string {
  if (c.gte != null && c.lte != null) return `${c.gte} – ${c.lte}`;
  if (c.gte != null) return `≥ ${c.gte}`;
  if (c.lte != null) return `≤ ${c.lte}`;
  return "any";
}

export function ParsedFilterPreview({ result }: { result: AiSearchResponse }) {
  const { query, notes, usedRepair } = result;
  const terms = query.filters.filter(isTerm);
  const ranges = query.filters.filter(isRange);
  const empty = !query.text && terms.length === 0 && ranges.length === 0;

  const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--tp-ink-3)" } as const;
  const rowStyle = { display: "flex", flexDirection: "column", gap: 6 } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {notes ? <p style={{ margin: 0, fontSize: 13, color: "var(--tp-ink-2)" }}>{notes}</p> : null}

      {empty ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--tp-ink-4)" }}>
          The AI didn't find any specific filters in that query. Applying it will clear the current
          filters and show all contacts — try a more specific description.
        </p>
      ) : null}

      {query.text ? (
        <div style={rowStyle}>
          <span style={labelStyle}>Keywords</span>
          <div>
            <TpChip>{query.text}</TpChip>
          </div>
        </div>
      ) : null}

      {terms.map((t) => (
        <div key={`${t.field}-${t.op}`} style={rowStyle}>
          <span style={labelStyle}>
            {t.field} {t.op === "exclude" ? "is not" : "is"}
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {t.values.map((v) => (
              <TpChip key={v}>{v}</TpChip>
            ))}
          </div>
        </div>
      ))}

      {ranges.map((r) => (
        <div key={`${r.field}-range`} style={rowStyle}>
          <span style={labelStyle}>{r.field}</span>
          <div>
            <TpChip>{rangeLabel(r)}</TpChip>
          </div>
        </div>
      ))}

      <div style={rowStyle}>
        <span style={labelStyle}>Sort</span>
        <div>
          <TpChip>{query.sort}</TpChip>
        </div>
      </div>

      {usedRepair ? (
        <p style={{ margin: 0, fontSize: 11, color: "var(--tp-ink-4)" }}>
          The first attempt needed a quick correction — please double-check the filter above.
        </p>
      ) : null}
    </div>
  );
}
