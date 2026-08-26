// titleTaxonomy.test.ts — data integrity for the canonical job-title taxonomy (24 §4, ADR-0035).
//
// titleTaxonomy.ts says "Data only — no logic", which is why it had no test. But the data has invariants, and
// every way of breaking them is SILENT:
//
//   • `buildLookup()` in canonicalizeTitle.ts states its own hazard — "first writer wins on collisions". Two
//     titles sharing a normalized surface form do not error; the one earlier in the array simply takes the
//     key, and the other becomes unreachable through that spelling. Nothing anywhere reports it.
//   • A surface form that normalizes to "" is dropped by the `if (key && !map.has(key))` guard, so an alias
//     of punctuation-only characters is accepted into the file and never matches anything.
//   • A duplicate `id` survives in the array but collapses in `CANONICAL_IDS` / `CANONICAL_BY_ID`
//     (packages/search/src/fields.ts builds both as Maps/Sets keyed by id), losing one title from the facet.
//
// Comparing RAW alias strings does not catch any of this, which is the trap: normalizeTitle expands tokens
// (`exec` → `executive`, `sr` → `senior`), so "chief exec" and "chief executive" are distinct strings and the
// SAME key. The 29 titles carry 95 raw aliases that collapse to 86 normalized keys — the collisions are
// intra-title and correct, but the same mechanism across two titles is a silent defect. So every assertion
// here compares NORMALIZED forms.
//
// Worth having because this file is explicitly a seed: its own header says the production taxonomy gets
// backfilled from O*NET-SOC/ESCO. Growth from 29 curated entries to thousands of generated ones is exactly
// when a duplicate alias arrives, and exactly when nobody is reading the diff line by line.

import { describe, expect, test } from "bun:test";
import { canonicalizeTitle } from "./canonicalizeTitle.ts";
import { normalizeTitle } from "./normalizeTitle.ts";
import { CANONICAL_TITLES } from "./titleTaxonomy.ts";

describe("canonical title taxonomy", () => {
  test("the seed is present (a gutted file must not pass everything below)", () => {
    expect(CANONICAL_TITLES.length).toBeGreaterThanOrEqual(25);
  });

  test("ids are unique", () => {
    // fields.ts keys a Set and a Map by id; a duplicate silently drops a title from the facet vocabulary.
    const ids = CANONICAL_TITLES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every surface form survives normalization", () => {
    // A form normalizing to "" is dropped by buildLookup's guard and can never be matched.
    const empty: string[] = [];
    for (const title of CANONICAL_TITLES) {
      for (const form of [title.label, ...title.aliases]) {
        if (normalizeTitle(form) === "") empty.push(`${title.id}: ${JSON.stringify(form)}`);
      }
    }
    expect(empty).toEqual([]);
  });

  test("no normalized surface form is claimed by two different titles", () => {
    // THE one that matters. buildLookup resolves this by array position and says nothing.
    const owners = new Map<string, Set<string>>();
    for (const title of CANONICAL_TITLES) {
      for (const form of [title.label, ...title.aliases]) {
        const key = normalizeTitle(form);
        if (!key) continue;
        if (!owners.has(key)) owners.set(key, new Set());
        (owners.get(key) as Set<string>).add(title.id);
      }
    }
    const ambiguous = [...owners.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([key, ids]) => `${JSON.stringify(key)} → ${[...ids].join(", ")}`);
    expect(ambiguous).toEqual([]);
  });

  test("every alias resolves back to its OWN title", () => {
    // End-to-end through the real lookup rather than re-deriving it: this is the property a user experiences
    // when they type "CEO" and expect the CEO occupation.
    const wrong: string[] = [];
    for (const title of CANONICAL_TITLES) {
      for (const form of [title.label, ...title.aliases]) {
        const got = canonicalizeTitle(form);
        if (got?.id !== title.id)
          wrong.push(`${JSON.stringify(form)} → ${got?.id ?? "null"} (want ${title.id})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("the abbreviations people actually type resolve", () => {
    // Spot checks in the spelling a user types, including the punctuation/case the normalizer is there to
    // absorb. If normalizeTitle's behaviour changes, these say so in user terms rather than as a key diff.
    expect(canonicalizeTitle("CEO")?.id).toBe("chief_executive_officer");
    expect(canonicalizeTitle("C.E.O.")?.id).toBe("chief_executive_officer");
    expect(canonicalizeTitle("  chief   executive officer ")?.id).toBe("chief_executive_officer");
  });

  test("an unknown title is null, not a wrong guess", () => {
    // Lookup is exact-match on the normalized form (the fuzzy tail is a later layer, ADR-0035 §14). Returning
    // a near-miss would be worse than nothing: it would mislabel the record's occupation facet.
    expect(canonicalizeTitle("supreme intergalactic wizard")).toBeNull();
    expect(canonicalizeTitle("")).toBeNull();
    expect(canonicalizeTitle("   ")).toBeNull();
  });

  test("seniority and function are populated for every title", () => {
    // Both feed facets; an empty one would render a blank filter row rather than fail.
    for (const title of CANONICAL_TITLES) {
      expect(title.seniority.length).toBeGreaterThan(0);
      expect(title.jobFunction.length).toBeGreaterThan(0);
      expect(title.aliases.length).toBeGreaterThan(0);
    }
  });
});
