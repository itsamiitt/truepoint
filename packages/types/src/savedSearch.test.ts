// savedSearch.test.ts — guards the saved-search contract (24 §8). These schemas are the single source of
// truth shared by apps/api + @leadwolf/core (filter validation on save) + apps/web, so they must: accept a
// well-formed create with a valid contactQuery blob, REJECT a malformed filter set (the "invalid filters
// rejected on save" acceptance criterion), default visibility to private, and require update to carry at
// least one field. Pure unit test (no DB).

import { describe, expect, it } from "bun:test";
import {
  createSavedSearchSchema,
  savedSearchVisibility,
  updateSavedSearchSchema,
} from "./savedSearch.ts";

const VALID_FILTERS = {
  text: "growth",
  filters: [
    { kind: "term", field: "seniority", op: "include", values: ["vp"] },
    { kind: "range", field: "employee_count", gte: 50 },
  ],
  sort: "score_desc",
  limit: 25,
};

describe("createSavedSearchSchema", () => {
  it("accepts a well-formed create and defaults visibility to private", () => {
    const parsed = createSavedSearchSchema.safeParse({
      name: "VP+ growth",
      filters: VALID_FILTERS,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.visibility).toBe("private");
      // contactQuery defaults are applied to the stored blob (op present, filters array kept).
      expect(parsed.data.filters.filters).toHaveLength(2);
      expect(parsed.data.filters.sort).toBe("score_desc");
    }
  });

  it("rejects an unknown facet field in a term clause (invalid filters never persist)", () => {
    const parsed = createSavedSearchSchema.safeParse({
      name: "broken",
      filters: { filters: [{ kind: "term", field: "not_a_facet", values: ["x"] }] },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty term values array", () => {
    const parsed = createSavedSearchSchema.safeParse({
      name: "broken",
      filters: { filters: [{ kind: "term", field: "seniority", values: [] }] },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a blank name", () => {
    expect(createSavedSearchSchema.safeParse({ name: "  ", filters: VALID_FILTERS }).success).toBe(
      false,
    );
  });

  it("rejects a non-enum visibility", () => {
    const parsed = createSavedSearchSchema.safeParse({
      name: "x",
      filters: VALID_FILTERS,
      visibility: "public",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("updateSavedSearchSchema", () => {
  it("accepts a rename only", () => {
    expect(updateSavedSearchSchema.safeParse({ name: "renamed" }).success).toBe(true);
  });

  it("accepts a visibility change only", () => {
    expect(updateSavedSearchSchema.safeParse({ visibility: "workspace" }).success).toBe(true);
  });

  it("rejects an empty patch (must change name or visibility)", () => {
    expect(updateSavedSearchSchema.safeParse({}).success).toBe(false);
  });
});

describe("savedSearchVisibility", () => {
  it("is exactly private | workspace", () => {
    expect(savedSearchVisibility.options).toEqual(["private", "workspace"]);
  });
});
