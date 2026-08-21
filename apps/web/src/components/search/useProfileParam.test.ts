// useProfileParam.test.ts — the profile-param codec's proof (search-consolidation stage 3).
//
// The hook itself needs a React tree, but the property that matters is pure and testable without one: the
// param set is EXCLUSIVE (opening one profile must clear any other) and orthogonal to everything else in
// the URL, so opening a drawer never disturbs either pane's filters. Those are the two ways this breaks
// silently — two drawers stacked, or a filter set quietly dropped when a rep clicks a row.

import { describe, expect, test } from "bun:test";
import { PROFILE_PARAMS, type ProfileKind } from "./useProfileParam.ts";

/** The exact write the hook performs. Kept in step with useProfileParam's `write`. */
function writeProfile(
  params: URLSearchParams,
  next: { kind: ProfileKind; key: string } | null,
): URLSearchParams {
  const out = new URLSearchParams(params.toString());
  for (const kind of PROFILE_PARAMS) out.delete(kind);
  if (next) out.set(next.kind, next.key);
  return out;
}

/** The exact read the hook performs: first match wins. */
function readProfile(params: URLSearchParams): { kind: ProfileKind; key: string } | null {
  for (const kind of PROFILE_PARAMS) {
    const key = params.get(kind);
    if (key) return { kind, key };
  }
  return null;
}

const SEARCH_STATE = {
  tab: "accounts",
  q: "growth",
  sort: "score_desc",
  f: "W3sia2luZCI6InRlcm0ifV0",
  aq: "acme",
  asort: "name_asc",
  af: "W3sia2luZCI6InRlcm0ifV0",
};

describe("profile params", () => {
  test("the four kinds round-trip", () => {
    for (const kind of PROFILE_PARAMS) {
      const written = writeProfile(new URLSearchParams(), { kind, key: "abc" });
      expect(readProfile(written)).toEqual({ kind, key: "abc" });
    }
  });

  test("opening one profile CLEARS any other — never two drawers at once", () => {
    let params = writeProfile(new URLSearchParams(), { kind: "person", key: "jane" });
    params = writeProfile(params, { kind: "company", key: "acme.com" });
    expect(params.get("person")).toBeNull();
    expect(params.get("company")).toBe("acme.com");
    expect(PROFILE_PARAMS.filter((k) => params.has(k))).toEqual(["company"]);
  });

  test("closing removes every profile param and nothing else", () => {
    const base = new URLSearchParams(SEARCH_STATE);
    const opened = writeProfile(base, { kind: "person", key: "jane" });
    const closed = writeProfile(opened, null);

    expect(readProfile(closed)).toBeNull();
    for (const [key, value] of Object.entries(SEARCH_STATE)) {
      expect(closed.get(key)).toBe(value);
    }
  });

  test("opening a profile disturbs NEITHER pane's filters", () => {
    // A rep clicking a row must not lose the search that found it — for either tab.
    const opened = writeProfile(new URLSearchParams(SEARCH_STATE), {
      kind: "company",
      key: "acme.com",
    });
    for (const [key, value] of Object.entries(SEARCH_STATE)) {
      expect(opened.get(key)).toBe(value);
    }
  });

  test("a hand-edited URL with two profile params resolves deterministically", () => {
    // Only reachable by editing the URL. Picking the first declared kind beats rendering two drawers or
    // throwing on a link someone mangled.
    const params = new URLSearchParams({ company: "acme.com", person: "jane" });
    expect(readProfile(params)).toEqual({ kind: "person", key: "jane" });
  });

  test("an empty param value is not an open profile", () => {
    expect(readProfile(new URLSearchParams({ person: "" }))).toBeNull();
  });
});
