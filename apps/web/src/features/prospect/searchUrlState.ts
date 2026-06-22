// searchUrlState.ts — the single source of truth for serialising the Prospect search/filter `ContactQuery` to
// and from the page URL (Done-When #5: a search is shareable, bookmarkable, and restored correctly after
// refresh or the back button). Pagination (cursor/limit) is deliberately EPHEMERAL and never written to the
// URL. The filter set is carried as one compact, URL-safe encoded blob and re-validated through the
// `contactQuery` Zod schema on read, so a hand-mangled or stale URL can never crash the page — it falls back to
// an empty (valid) query. The query keys (q/sort/f) are written onto a CALLER-SUPPLIED params object so
// non-query params (e.g. ?scope) survive. Pure module: no React, no DOM beyond URLSearchParams; unit-tested.

import { type ContactQuery, contactQuery } from "@leadwolf/types";

const QUERY_KEYS = ["q", "sort", "f"] as const;

/** An empty, valid query (all Zod defaults applied) — the safe fallback for an absent/invalid URL. */
export function emptyQuery(): ContactQuery {
  return contactQuery.parse({});
}

/** Write the query keys (q/sort/f) onto `into` (a fresh params by default), clearing any stale query keys
 *  first while leaving every other param (e.g. ?scope) untouched. Defaults (relevance sort, no text/filters)
 *  are omitted so a pristine query yields a clean URL. `limit`/`cursor` are NOT persisted. */
export function queryToParams(query: ContactQuery, into?: URLSearchParams): URLSearchParams {
  const params = into ?? new URLSearchParams();
  for (const k of QUERY_KEYS) params.delete(k);
  if (query.text) params.set("q", query.text);
  if (query.sort && query.sort !== "relevance") params.set("sort", query.sort);
  if (query.filters.length > 0) params.set("f", encodeFilters(query.filters));
  return params;
}

/** Parse the ContactQuery back from URL params. The filter blob is re-validated through `contactQuery`;
 *  anything invalid degrades to an empty query rather than throwing (a robust, shareable-URL contract). */
export function paramsToQuery(params: URLSearchParams): ContactQuery {
  const candidate = {
    text: params.get("q") ?? undefined,
    sort: params.get("sort") ?? undefined,
    filters: decodeFilters(params.get("f")),
    // limit is ephemeral; let the schema default apply.
  };
  const parsed = contactQuery.safeParse(candidate);
  return parsed.success ? parsed.data : emptyQuery();
}

/** Convenience: the URL search string (no leading "?") for a query, merged onto optional base params. */
export function queryToSearchString(query: ContactQuery, base?: URLSearchParams): string {
  return queryToParams(query, base).toString();
}

/** Convenience: parse a query from a raw search string (with or without a leading "?"). */
export function searchStringToQuery(search: string): ContactQuery {
  return paramsToQuery(new URLSearchParams(search.startsWith("?") ? search.slice(1) : search));
}

// ── filter blob codec (unicode-safe base64url of the filters JSON) ──────────────────────────────────────
function encodeFilters(filters: ContactQuery["filters"]): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(filters)));
}

function decodeFilters(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const json = new TextDecoder().decode(fromBase64Url(raw));
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
