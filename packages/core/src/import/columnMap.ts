// columnMap.ts — apply a ColumnMapping (canonical field → source header) to one parsed row, pulling the
// mapped source columns into a canonical-field record. Unmapped source columns are NOT dropped here — the
// caller keeps the full raw row for source_imports.raw_data; this only selects the fields dedup/normalize
// care about. Pure + synchronous (16 §1).

import type { CanonicalField, ColumnMapping } from "@leadwolf/types";

export type RawRow = Record<string, string>;
export type MappedRow = Partial<Record<CanonicalField, string>>;

/** Select mapped, non-empty source values keyed by canonical field. */
export function mapRow(raw: RawRow, mapping: ColumnMapping): MappedRow {
  const out: MappedRow = {};
  for (const [field, header] of Object.entries(mapping) as [CanonicalField, string][]) {
    const value = raw[header];
    if (value != null && value.trim() !== "") out[field] = value;
  }
  return out;
}
