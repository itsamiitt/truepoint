// MappingGrid.tsx — the column-mapper grid (canonical field ⇒ source-header dropdowns, grouped). Extracted
// unchanged from ImportWizard.tsx (S-U7 file-size split) so the legacy one-shot card and the draft-backed
// step flow render the EXACT same control — one mapper, two flows. Presentation only; the parent owns the
// mapping state and the preview invalidation that a change implies.
"use client";

import type { CanonicalField } from "@leadwolf/types";
import { TpSelect } from "@leadwolf/ui";
import { MAPPABLE_FIELDS, type MappableField } from "../types";

const GROUPS = ["Identity", "Person", "Company", "Location"] as const;

export function MappingGrid({
  headers,
  mapping,
  onChange,
}: {
  headers: string[];
  mapping: Partial<Record<CanonicalField, string>>;
  onChange: (field: CanonicalField, value: string) => void;
}) {
  return (
    <div className="tp-mapper">
      {GROUPS.map((group) => (
        <fieldset key={group} className="tp-group">
          <legend>{group}</legend>
          {MAPPABLE_FIELDS.filter((f: MappableField) => f.group === group).map((f) => (
            <label key={f.field} className="tp-field">
              <span>{f.label}</span>
              <TpSelect
                value={mapping[f.field] ?? ""}
                onChange={(e) => onChange(f.field, e.target.value)}
              >
                <option value="">— not mapped —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </TpSelect>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}
