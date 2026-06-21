// fields.ts — how a contact row projects onto each facet, shared by the in-memory adapter's matching,
// suggest, and facet-count paths (24 §3/§5). `key` is the normalized comparison token (a canonical title
// id, or a normalized string); `label` is the human display. Title uses the canonical taxonomy so "CEO"
// and "Chief Executive Officer" collapse to one key. Free-text engines (OpenSearch/Typesense) do this
// natively; this module reproduces just enough of it for the dev/test adapter (ADR-0002 fallback).

import { CANONICAL_TITLES, canonicalizeTitle, normalizeTitle } from "@leadwolf/core";
import type { ContactHit, FacetKey } from "@leadwolf/types";

const CANONICAL_IDS: ReadonlySet<string> = new Set(CANONICAL_TITLES.map((t) => t.id));
const CANONICAL_BY_ID = new Map(CANONICAL_TITLES.map((t) => [t.id, t]));

/** A facet projection of a row: the normalized match key + the human-readable label. */
export interface FacetValue {
  key: string;
  label: string;
}

/** True when a key is a canonical title id (so suggestions can carry `canonicalId`). */
export function isCanonicalId(key: string): boolean {
  return CANONICAL_IDS.has(key);
}

/** Normalize a filter/prefix value the same way the row's value for that field is normalized. */
export function normalizeForField(field: FacetKey, value: string): string {
  if (field === "title" || field === "department" || field === "location") {
    return normalizeTitle(value);
  }
  return value.trim().toLowerCase();
}

/** Project a row onto a facet → its (key,label) values. Empty when the row has no value for that facet. */
export function facetDisplay(row: ContactHit, field: FacetKey): FacetValue[] {
  switch (field) {
    case "title": {
      if (!row.jobTitle) return [];
      const fromId = row.canonicalTitleId ? CANONICAL_BY_ID.get(row.canonicalTitleId) : undefined;
      const canon = fromId ?? canonicalizeTitle(row.jobTitle);
      return canon
        ? [{ key: canon.id, label: canon.label }]
        : [{ key: normalizeTitle(row.jobTitle), label: row.jobTitle }];
    }
    case "seniority":
      return row.seniorityLevel ? [{ key: row.seniorityLevel, label: row.seniorityLevel }] : [];
    case "department":
      return row.department ? [{ key: normalizeTitle(row.department), label: row.department }] : [];
    case "location": {
      const out: FacetValue[] = [];
      if (row.locationCity)
        out.push({ key: normalizeTitle(row.locationCity), label: row.locationCity });
      if (row.locationCountry)
        out.push({ key: normalizeTitle(row.locationCountry), label: row.locationCountry });
      return out;
    }
    case "company":
      return row.emailDomain
        ? [{ key: row.emailDomain.toLowerCase(), label: row.emailDomain }]
        : [];
    // Engagement facets backed by the masked view (the soft-owner search dimensions).
    case "owner":
      return row.ownerUserId ? [{ key: row.ownerUserId, label: row.ownerUserId }] : [];
    case "outreach_status":
      return [{ key: row.outreachStatus, label: row.outreachStatus }];
    case "email_status":
      return [{ key: row.emailStatus, label: row.emailStatus }];
    case "industry":
    case "technology":
    case "skill":
    case "source":
    case "funding_stage":
    case "company_stage":
      // Not present on the masked contact view — the real index / Postgres adapter carries these (account +
      // source-import joins); the dev adapter can't project them.
      return [];
    default:
      return [];
  }
}

/** The normalized match keys for a row + facet (the `key`s from facetDisplay). */
export function facetKeys(row: ContactHit, field: FacetKey): string[] {
  return facetDisplay(row, field).map((v) => v.key);
}
