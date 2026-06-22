// searchUrlState.ts — the single source of truth for serialising the Prospect search/filter state to and
// from the page URL (Done-When #5: a view is shareable, bookmarkable, and restored correctly after refresh or
// the back button). State is the validated server `ContactQuery` (search.ts) plus the list/card view toggle;
// pagination (cursor/limit) is deliberately EPHEMERAL and never written to the URL. The filter set is carried
// as one compact, URL-safe encoded blob and re-validated through the `contactQuery` Zod schema on read, so a
// hand-mangled or stale URL can never crash the page — it falls back to an empty (valid) query. Pure module:
// no React, no DOM beyond URLSearchParams; fully unit-tested.

import { type ContactQuery, contactQuery } from "@leadwolf/types";

export type ProspectView = "list" | "card";

export interface ProspectViewState {
  query: ContactQuery;
  view: ProspectView;
}

/** An empty, valid query (all Zod defaults applied) — the safe fallback for an absent/invalid URL. */
export function emptyQuery(): ContactQuery {
  return contactQuery.parse({});
}

/** Serialise the view state to URL params. Defaults (relevance sort, list view, no text/filters) are omitted
 *  so a pristine view yields a clean URL. `limit`/`cursor` are NOT persisted (pagination is ephemeral). */
export function stateToParams(state: ProspectViewState): URLSearchParams {
  const params = new URLSearchParams();
  const { query, view } = state;
  if (query.text) params.set("q", query.text);
  if (query.sort && query.sort !== "relevance") params.set("sort", query.sort);
  if (query.filters.length > 0) params.set("f", encodeFilters(query.filters));
  if (view !== "list") params.set("view", view);
  return params;
}

/** Parse view state back from URL params. The filter blob is re-validated through `contactQuery`; anything
 *  invalid degrades to an empty query rather than throwing (a robust, shareable-URL contract). */
export function paramsToState(params: URLSearchParams): ProspectViewState {
  const candidate = {
    text: params.get("q") ?? undefined,
    sort: params.get("sort") ?? undefined,
    filters: decodeFilters(params.get("f")),
    // limit is ephemeral; let the schema default apply.
  };
  const parsed = contactQuery.safeParse(candidate);
  const query = parsed.success ? parsed.data : emptyQuery();
  const view: ProspectView = params.get("view") === "card" ? "card" : "list";
  return { query, view };
}

/** Convenience: the URL search string (no leading "?") for a state — what the page pushes to history. */
export function stateToSearchString(state: ProspectViewState): string {
  return stateToParams(state).toString();
}

/** Convenience: parse from a raw search string (with or without a leading "?"). */
export function searchStringToState(search: string): ProspectViewState {
  return paramsToState(new URLSearchParams(search.startsWith("?") ? search.slice(1) : search));
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
