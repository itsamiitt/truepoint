// useRecentSearches.test.ts — the pure recents helpers (24, Done-When #4): canonical key (dedupe identity),
// human label, recordable guard, and the dedupe+cap list merge. No localStorage/DOM.

import { describe, expect, test } from "bun:test";
import type { ContactQuery } from "@leadwolf/types";
import {
  type RecentSearch,
  isRecordable,
  mergeRecent,
  recentKey,
  recentLabel,
} from "./useRecentSearches.ts";

const q = (over: Partial<ContactQuery> = {}): ContactQuery => ({
  filters: [],
  sort: "relevance",
  limit: 50,
  ...over,
});

describe("recents helpers", () => {
  test("recentKey ignores limit/cursor but distinguishes text/filters/sort", () => {
    expect(recentKey(q({ text: "a", limit: 50 }))).toBe(recentKey(q({ text: "a", limit: 200 })));
    expect(recentKey(q({ text: "a" }))).not.toBe(recentKey(q({ text: "b" })));
    expect(recentKey(q({ sort: "score_desc" }))).not.toBe(recentKey(q({ sort: "relevance" })));
  });

  test("recentLabel summarises text + filter count, else 'All prospects'", () => {
    expect(recentLabel(q())).toBe("All prospects");
    expect(recentLabel(q({ text: "growth" }))).toBe('"growth"');
    const withFilter = q({
      text: "vp",
      filters: [{ kind: "term", field: "seniority", op: "include", values: ["vp"] }],
    });
    expect(recentLabel(withFilter)).toBe('"vp" · 1 filter');
  });

  test("isRecordable: empty query is not recorded; text or filters make it recordable", () => {
    expect(isRecordable(q())).toBe(false);
    expect(isRecordable(q({ text: "x" }))).toBe(true);
    expect(isRecordable(q({ filters: [{ kind: "bool", field: "has_email", value: true }] }))).toBe(
      true,
    );
  });

  test("mergeRecent puts newest first, de-dupes by id, and caps", () => {
    const mk = (id: string): RecentSearch => ({ id, query: q(), label: id, at: 0 });
    let list: RecentSearch[] = [];
    list = mergeRecent(list, mk("a"));
    list = mergeRecent(list, mk("b"));
    list = mergeRecent(list, mk("a")); // re-run "a" → moves to front, no duplicate
    expect(list.map((r) => r.id)).toEqual(["a", "b"]);

    let capped: RecentSearch[] = [];
    for (let i = 0; i < 12; i++) capped = mergeRecent(capped, mk(`q${i}`), 8);
    expect(capped).toHaveLength(8);
    expect(capped[0]?.id).toBe("q11"); // newest kept
  });
});
