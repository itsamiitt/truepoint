// searchUrlState.test.ts — the Prospect URL-state round-trip proof (Done-When #5). Covers: a full query
// (text + sort + term include/exclude + bool + range + view) survives serialise→parse unchanged; a pristine
// state yields a clean (empty) URL; and a mangled/invalid filter blob degrades to an empty query instead of
// throwing. Pure unit test — no DB, no DOM.

import { describe, expect, test } from "bun:test";
import type { ContactQuery } from "@leadwolf/types";
import {
  type ProspectViewState,
  emptyQuery,
  paramsToState,
  searchStringToState,
  stateToParams,
  stateToSearchString,
} from "./searchUrlState.ts";

function roundTrip(state: ProspectViewState): ProspectViewState {
  return searchStringToState(stateToSearchString(state));
}

const FULL: ContactQuery = {
  text: "growth",
  sort: "score_desc",
  limit: 50,
  filters: [
    { kind: "term", field: "seniority", op: "include", values: ["vp", "director"] },
    { kind: "term", field: "industry", op: "exclude", values: ["Retail"] },
    { kind: "bool", field: "has_email", value: true },
    { kind: "range", field: "score", gte: 70 },
  ],
};

describe("prospect URL state round-trip", () => {
  test("a full query + view survives serialise → parse unchanged", () => {
    const state: ProspectViewState = { query: FULL, view: "card" };
    const back = roundTrip(state);
    expect(back.view).toBe("card");
    expect(back.query.text).toBe("growth");
    expect(back.query.sort).toBe("score_desc");
    expect(back.query.filters).toEqual(FULL.filters);
  });

  test("a pristine state yields a clean URL (only defaults → no params)", () => {
    const params = stateToParams({ query: emptyQuery(), view: "list" });
    expect(params.toString()).toBe("");
  });

  test("text + sort + view are readable params; filters are one encoded blob", () => {
    const params = stateToParams({ query: FULL, view: "card" });
    expect(params.get("q")).toBe("growth");
    expect(params.get("sort")).toBe("score_desc");
    expect(params.get("view")).toBe("card");
    expect(params.get("f")).toBeTruthy(); // opaque but present
  });

  test("a mangled filter blob degrades to an empty query (never throws)", () => {
    const state = paramsToState(new URLSearchParams("q=hi&f=%%%not-base64%%%"));
    expect(state.query.text).toBe("hi");
    expect(state.query.filters).toEqual([]); // invalid blob dropped, not fatal
  });

  test("an invalid filter clause (bad facet) is rejected → empty query, not a crash", () => {
    // Encode a filters array with an unknown facet; contactQuery.safeParse must reject it on read.
    const bad = btoa(JSON.stringify([{ kind: "term", field: "not_a_facet", values: ["x"] }]))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const state = paramsToState(new URLSearchParams(`f=${bad}`));
    expect(state.query.filters).toEqual([]);
  });

  test("default sort + list view are omitted from the URL", () => {
    const params = stateToParams({ query: { ...emptyQuery(), text: "x" }, view: "list" });
    expect(params.has("sort")).toBe(false);
    expect(params.has("view")).toBe(false);
    expect(params.get("q")).toBe("x");
  });
});
