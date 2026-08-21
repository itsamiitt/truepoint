// searchTabUrlState.test.ts — the Search tab codec's proof (search-consolidation, Phase 4 §"tab state
// survives refresh"). The property that actually matters is the one the whole two-tab design rests on:
// writing a tab must leave BOTH panes' query params untouched, so the inactive tab's filters survive a
// switch and a shared URL restores exactly what the sharer saw. Pure unit test — no DB, no DOM.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SEARCH_TAB,
  paramsToSearchTab,
  parseSearchTab,
  searchTabFromLegacyScope,
  searchTabToParams,
} from "./searchTabUrlState.ts";

describe("parseSearchTab", () => {
  test("accepts the two real tabs", () => {
    expect(parseSearchTab("people")).toBe("people");
    expect(parseSearchTab("accounts")).toBe("accounts");
  });

  test("degrades anything else to the default rather than throwing", () => {
    // A hand-mangled or stale URL must never crash the surface — the same contract searchUrlState holds
    // for the filter blob.
    for (const raw of [null, undefined, "", "Accounts", "companies", "../../etc/passwd"]) {
      expect(parseSearchTab(raw)).toBe(DEFAULT_SEARCH_TAB);
    }
  });
});

describe("searchTabToParams", () => {
  test("omits the default tab so a pristine view yields a clean URL", () => {
    expect(searchTabToParams("people").toString()).toBe("");
  });

  test("writes a non-default tab", () => {
    expect(searchTabToParams("accounts").toString()).toBe("tab=accounts");
  });

  test("round-trips through paramsToSearchTab", () => {
    for (const tab of ["people", "accounts"] as const) {
      expect(paramsToSearchTab(searchTabToParams(tab))).toBe(tab);
    }
  });

  test("leaves BOTH panes' query params untouched — the whole point of one URL, two tabs", () => {
    // q/sort/f belong to the People codec; aq/asort/af to the Accounts codec. A tab write touches neither.
    const params = new URLSearchParams({
      q: "growth",
      sort: "score_desc",
      f: "W3sia2luZCI6InRlcm0ifV0",
      aq: "acme",
      asort: "name_asc",
      af: "W3sia2luZCI6InRlcm0ifV0",
    });
    const before = params.toString();

    const written = searchTabToParams("accounts", new URLSearchParams(before));
    for (const key of ["q", "sort", "f", "aq", "asort", "af"]) {
      expect(written.get(key)).toBe(params.get(key));
    }
    expect(written.get("tab")).toBe("accounts");

    // …and switching back removes the key entirely rather than leaving `tab=people` behind.
    const backToPeople = searchTabToParams("people", written);
    expect(backToPeople.has("tab")).toBe(false);
    for (const key of ["q", "sort", "f", "aq", "asort", "af"]) {
      expect(backToPeople.get(key)).toBe(params.get(key));
    }
  });
});

describe("searchTabFromLegacyScope", () => {
  test("maps the retired ?scope=accounts deep link onto the Accounts tab", () => {
    expect(searchTabFromLegacyScope("accounts")).toBe("accounts");
  });

  test("returns null for anything else, so it never overrides an explicit tab", () => {
    for (const raw of [null, undefined, "", "contacts", "people"]) {
      expect(searchTabFromLegacyScope(raw)).toBeNull();
    }
  });
});
