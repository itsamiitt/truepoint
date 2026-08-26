// backfillTitleFunction.test.ts — the decisions a backfill would write.
//
// The risk in a backfill is never the loop; it is writing the wrong value to a very large number of rows in
// one go, at a moment when nobody is watching. So the mapping is a pure exported function and this asserts it
// directly, including that it agrees with the live writer rather than being a second implementation of the
// taxonomy — which is the exact reason migration 0136 refused to do this in SQL.

import { describe, expect, test } from "bun:test";
import { canonicalizeTitle } from "../search/canonicalizeTitle.ts";
import { decideTitleFunctions } from "./backfillTitleFunction.ts";

describe("decideTitleFunctions", () => {
  test("derives the function from the title, per the taxonomy", () => {
    const rows = [
      { id: "11111111-1111-4111-8111-111111111111", jobTitle: "VP of Engineering" },
      { id: "22222222-2222-4222-8222-222222222222", jobTitle: "Chief Financial Officer" },
    ];
    const decided = decideTitleFunctions(rows);

    expect(decided).toHaveLength(2);
    // Both titles must actually RESOLVE. Without this the assertions below would be satisfied by
    // null === null — holding while proving nothing, which is the shape of a test that silently stopped
    // testing. (They resolve to "engineering" and "finance" today.)
    expect(decided[0]?.jobFunction).not.toBeNull();
    expect(decided[1]?.jobFunction).not.toBeNull();
    // Asserted against the taxonomy call itself, NOT against a hardcoded string. A literal here would pass
    // while silently disagreeing with landSourcePayload the moment the taxonomy changed — and a backfill that
    // disagrees with the live writer is worse than no backfill, because it writes the disagreement to history.
    expect(decided[0]?.jobFunction).toBe(
      canonicalizeTitle("VP of Engineering")?.jobFunction ?? null,
    );
    expect(decided[1]?.jobFunction).toBe(
      canonicalizeTitle("Chief Financial Officer")?.jobFunction ?? null,
    );
  });

  test("an unresolvable title decides NULL, and that is a legitimate outcome", () => {
    const decided = decideTitleFunctions([
      { id: "33333333-3333-4333-8333-333333333333", jobTitle: "Chief Vibes Officer, Third Floor" },
    ]);
    // Not an error and not a skip: the filter simply never matches those rows. landSourcePayload documents
    // the same rule, so the backfill must not invent a fallback bucket the live writer would never produce.
    expect(decided[0]?.jobFunction).toBeNull();
  });

  test("carries the id through unchanged — the write targets it", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const decided = decideTitleFunctions([{ id, jobTitle: "Account Executive" }]);
    expect(decided[0]?.id).toBe(id);
    expect(decided[0]?.jobTitle).toBe("Account Executive");
  });

  test("an empty page decides nothing", () => {
    expect(decideTitleFunctions([])).toEqual([]);
  });

  test("every decision is either null or a non-empty string — never an empty bucket", () => {
    // An empty-string function would be indexable, matchable, and meaningless: a filter for "" would return
    // those people. NULL is the only correct way to say "not derivable".
    const decided = decideTitleFunctions([
      { id: "55555555-5555-4555-8555-555555555555", jobTitle: "Software Engineer" },
      { id: "66666666-6666-4666-8666-666666666666", jobTitle: "?????" },
      { id: "77777777-7777-4777-8777-777777777777", jobTitle: "" },
    ]);
    for (const d of decided) {
      expect(d.jobFunction === null || d.jobFunction.length > 0).toBe(true);
    }
  });
});
