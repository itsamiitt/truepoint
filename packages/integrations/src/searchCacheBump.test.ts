// searchCacheBump.test.ts — the S5b shared bump contract: fail-open INCR + the two job-data scope shapes
// the search-mutating queues carry (nested `scope` for imports v2/bulk-reveal, flat ids for reverification).

import { describe, expect, test } from "bun:test";
import { searchVersionKey } from "@leadwolf/core";
import { bumpSearchVersion, scopeFromJobData } from "./searchCacheBump.ts";

const SCOPE = {
  tenantId: "0f0e0d0c-0b0a-7999-8888-777766665555",
  workspaceId: "11112222-3333-7444-8555-666677778888",
};

describe("bumpSearchVersion", () => {
  test("INCRs the workspace's generation key", async () => {
    const calls: string[] = [];
    await bumpSearchVersion(
      {
        async incr(key) {
          calls.push(key);
          return 1;
        },
      },
      SCOPE,
    );
    expect(calls).toEqual([searchVersionKey(SCOPE)]);
  });

  test("fails open: a Redis error is swallowed, never thrown", async () => {
    await bumpSearchVersion(
      {
        async incr() {
          throw new Error("redis down");
        },
      },
      SCOPE,
    );
    // reaching here IS the assertion
    expect(true).toBe(true);
  });
});

describe("scopeFromJobData", () => {
  test("nested scope shape (imports v2, bulk-reveal)", () => {
    expect(scopeFromJobData({ kind: "drive", jobId: "x", scope: SCOPE })).toEqual(SCOPE);
  });

  test("flat ids shape (reverification)", () => {
    expect(scopeFromJobData({ ...SCOPE, batch: 3 })).toEqual(SCOPE);
  });

  test("no workspace identity → undefined (nothing to bump)", () => {
    expect(scopeFromJobData({ tenantId: SCOPE.tenantId })).toBeUndefined();
    expect(scopeFromJobData({})).toBeUndefined();
    expect(scopeFromJobData(null)).toBeUndefined();
    expect(scopeFromJobData("sweep")).toBeUndefined();
  });
});
