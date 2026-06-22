// searchUrlState.test.ts — the Prospect URL-state round-trip proof (Done-When #5). Covers: a full ContactQuery
// (text + sort + term include/exclude + bool + range) survives serialise→parse unchanged; a pristine query
// yields a clean URL; a mangled/invalid filter blob degrades to an empty query instead of throwing; and
// non-query params (e.g. ?scope) survive a query write. Pure unit test — no DB, no DOM.

import { describe, expect, test } from "bun:test";
import type { ContactQuery } from "@leadwolf/types";
import {
  emptyQuery,
  paramsToQuery,
  queryToParams,
  queryToSearchString,
  searchStringToQuery,
} from "./searchUrlState.ts";

const roundTrip = (q: ContactQuery): ContactQuery => searchStringToQuery(queryToSearchString(q));

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
  test("a full query survives serialise → parse unchanged", () => {
    const back = roundTrip(FULL);
    expect(back.text).toBe("growth");
    expect(back.sort).toBe("score_desc");
    expect(back.filters).toEqual(FULL.filters);
  });

  test("a pristine query yields a clean URL (only defaults → no params)", () => {
    expect(queryToParams(emptyQuery()).toString()).toBe("");
  });

  test("text + sort are readable params; filters are one encoded blob", () => {
    const params = queryToParams(FULL);
    expect(params.get("q")).toBe("growth");
    expect(params.get("sort")).toBe("score_desc");
    expect(params.get("f")).toBeTruthy(); // opaque but present
  });

  test("non-query params (e.g. ?scope) survive a query write; stale query keys are cleared", () => {
    const base = new URLSearchParams("scope=accounts&q=old&sort=created_desc");
    const out = queryToParams({ ...emptyQuery(), text: "new" }, base);
    expect(out.get("scope")).toBe("accounts"); // preserved
    expect(out.get("q")).toBe("new"); // overwritten
    expect(out.has("sort")).toBe(false); // stale query key cleared (new query uses default sort)
  });

  test("a mangled filter blob degrades to an empty query (never throws)", () => {
    const q = paramsToQuery(new URLSearchParams("q=hi&f=%%%not-base64%%%"));
    expect(q.text).toBe("hi");
    expect(q.filters).toEqual([]); // invalid blob dropped, not fatal
  });

  test("an invalid filter clause (bad facet) is rejected → empty query, not a crash", () => {
    const bad = btoa(JSON.stringify([{ kind: "term", field: "not_a_facet", values: ["x"] }]))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(paramsToQuery(new URLSearchParams(`f=${bad}`)).filters).toEqual([]);
  });

  test("default sort is omitted from the URL", () => {
    const params = queryToParams({ ...emptyQuery(), text: "x" });
    expect(params.has("sort")).toBe(false);
    expect(params.get("q")).toBe("x");
  });
});
