// canonicalizeTitle.ts — resolve a raw job title to its canonical occupation (24 §4.2, ADR-0035). Run at
// index time (so facet counts + suggestions group by occupation, not spelling) and at query time (so a
// typed "CEO" maps to the same canonical as a stored "Chief Executive Officer"). Lookup is exact-match on
// the normalized form; the fuzzy/semantic tail (BM25 + kNN) is a later, optional layer (ADR-0035 §14).

import type { SeniorityLevel, TitleFunction } from "@leadwolf/types";
import { normalizeTitle } from "./normalizeTitle.ts";
import { CANONICAL_TITLES, type CanonicalTitle } from "./titleTaxonomy.ts";

/** The slim canonical result attached to a record / suggestion (the aliases stay internal). */
export interface CanonicalizedTitle {
  id: string;
  label: string;
  seniority: SeniorityLevel;
  jobFunction: TitleFunction;
}

/** normalized surface form → its canonical title. Built once; first writer wins on collisions. */
const LOOKUP: ReadonlyMap<string, CanonicalTitle> = buildLookup();

function buildLookup(): Map<string, CanonicalTitle> {
  const map = new Map<string, CanonicalTitle>();
  for (const title of CANONICAL_TITLES) {
    for (const form of [title.label, ...title.aliases]) {
      const key = normalizeTitle(form);
      if (key && !map.has(key)) map.set(key, title);
    }
  }
  return map;
}

/** Internal: the full canonical record (incl. aliases) for a raw title, or null if unknown. */
export function findCanonicalTitle(raw: string): CanonicalTitle | null {
  const key = normalizeTitle(raw);
  if (!key) return null;
  return LOOKUP.get(key) ?? null;
}

/** Public: the slim canonical occupation for a raw title, or null if it isn't in the taxonomy. */
export function canonicalizeTitle(raw: string): CanonicalizedTitle | null {
  const hit = findCanonicalTitle(raw);
  if (!hit) return null;
  return { id: hit.id, label: hit.label, seniority: hit.seniority, jobFunction: hit.jobFunction };
}
