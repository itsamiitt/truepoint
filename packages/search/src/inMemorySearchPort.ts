// inMemorySearchPort.ts — a fully in-memory SearchPort for dev, tests, and tiny environments (the fallback
// ADR-0002 calls for). It proves the whole contract end-to-end without infra: a title filter of "CEO"
// matches a row stored as "Chief Executive Officer" (24 §4) via the core taxonomy. Production search runs on
// OpenSearch (global) / Typesense (overlay); those adapters land here later behind the same interface.
//
// Scope/limits (documented, not silent): term filters + free-text + title canonicalization + suggest +
// facet counts + keyset paging are supported. Range filters and industry/technology/skill facets are NOT
// (the masked contact view has no such columns) — range clauses are ignored by this adapter only.

import { planTitleFilter } from "@leadwolf/core";
import type {
  ContactHit,
  ContactQuery,
  FacetCount,
  FacetKey,
  SearchCtx,
  SearchPage,
  SearchPort,
  Suggestion,
  SuggestQuery,
  TermFilter,
} from "@leadwolf/types";
import { facetDisplay, facetKeys, isCanonicalId, normalizeForField } from "./fields.ts";

/** A contact row plus the workspace it belongs to (the in-memory store is workspace-tagged). */
export interface IndexedContact extends ContactHit {
  workspaceId: string;
}

/** Build an in-memory SearchPort over a fixed set of workspace-tagged rows. */
export function createInMemorySearchPort(seed: readonly IndexedContact[]): SearchPort {
  const rowsFor = (ctx: SearchCtx) => seed.filter((r) => r.workspaceId === ctx.workspaceId);

  return {
    async searchContacts(query: ContactQuery, ctx: SearchCtx): Promise<SearchPage<ContactHit>> {
      const matched = rowsFor(ctx)
        .filter((r) => matchesQuery(r, query))
        .sort(byCreatedDescThenId);
      const start = query.cursor ? indexAfterCursor(matched, query.cursor) : 0;
      const page = matched.slice(start, start + query.limit);
      const more = start + query.limit < matched.length;
      const last = page[page.length - 1];
      const nextCursor = more && last ? last.id : null;
      return { hits: page, nextCursor };
    },

    async suggest(req: SuggestQuery, ctx: SearchCtx): Promise<Suggestion[]> {
      const prefix = normalizeForField(req.field, req.prefix);
      // For titles, also accept rows whose canonical id matches what the prefix expands to ("ceo" → canonical).
      const expandedIds = req.field === "title" ? planTitleFilter([req.prefix]).canonicalIds : [];
      const agg = aggregate(rowsFor(ctx), req.field);

      const out: Suggestion[] = [];
      for (const [key, entry] of agg) {
        const labelNorm = normalizeForField(req.field, entry.label);
        const matches =
          key.startsWith(prefix) || labelNorm.startsWith(prefix) || expandedIds.includes(key);
        if (!matches) continue;
        out.push({
          value: entry.label,
          displayLabel: entry.label,
          count: entry.count,
          canonicalId: req.field === "title" && isCanonicalId(key) ? key : undefined,
        });
      }
      out.sort((a, b) => b.count - a.count || a.displayLabel.localeCompare(b.displayLabel));
      return out.slice(0, req.limit);
    },

    async facetCounts(
      query: ContactQuery,
      fields: FacetKey[],
      ctx: SearchCtx,
    ): Promise<FacetCount[]> {
      const matched = rowsFor(ctx).filter((r) => matchesQuery(r, query));
      const out: FacetCount[] = [];
      for (const field of fields) {
        for (const [key, entry] of aggregate(matched, field)) {
          out.push({ field, value: key, displayLabel: entry.label, count: entry.count });
        }
      }
      out.sort((a, b) => b.count - a.count);
      return out;
    },

    async index(): Promise<void> {
      // No-op: the in-memory store IS the index. Real adapters apply CDC changes here (ADR-0002 §3).
    },
  };
}

// ── internals ──────────────────────────────────────────────────────────────────────────────────────────

function matchesQuery(row: ContactHit, query: ContactQuery): boolean {
  for (const clause of query.filters) {
    if (clause.kind === "term" && !matchesTerm(row, clause)) return false;
    // range clauses are unsupported by the dev adapter (no numeric facets on the masked view) — skipped.
  }
  if (query.text && !matchesText(row, query.text)) return false;
  return true;
}

function matchesTerm(row: ContactHit, filter: TermFilter): boolean {
  const rowKeys = facetKeys(row, filter.field);
  const filterKeys =
    filter.field === "title"
      ? expandTitleFilterKeys(filter.values)
      : filter.values.map((v) => normalizeForField(filter.field, v));
  const hit = rowKeys.some((k) => filterKeys.includes(k));
  return filter.op === "exclude" ? !hit : hit;
}

/** Title filter values expand to their canonical ids + synonyms so abbreviations match (24 §4). */
function expandTitleFilterKeys(values: string[]): string[] {
  const plan = planTitleFilter(values);
  return [...plan.canonicalIds, ...plan.synonyms];
}

function matchesText(row: ContactHit, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [row.firstName, row.lastName, row.jobTitle, row.emailDomain]
    .filter((v): v is string => Boolean(v))
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function aggregate(
  rows: readonly ContactHit[],
  field: FacetKey,
): Map<string, { label: string; count: number }> {
  const agg = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    for (const fv of facetDisplay(row, field)) {
      const entry = agg.get(fv.key) ?? { label: fv.label, count: 0 };
      entry.count += 1;
      agg.set(fv.key, entry);
    }
  }
  return agg;
}

/** Deterministic order: newest first, then id — gives a stable keyset cursor for the dev adapter. */
function byCreatedDescThenId(a: ContactHit, b: ContactHit): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function indexAfterCursor(sorted: readonly ContactHit[], cursor: string): number {
  const idx = sorted.findIndex((r) => r.id === cursor);
  return idx >= 0 ? idx + 1 : 0;
}
