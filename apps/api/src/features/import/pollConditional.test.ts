// pollConditional.test.ts — the HTTP half of TP-4, over the real route.
//
// The nightly soak has carried this as an explicit `test.todo` since it was written:
//
//   "TP-4 (HTTP): ETag/304 + Cache-Control: private, max-age=2 on GET /imports/:id — route header not
//    shipped yet"
//
// with a note to wire the header and then turn the todo into a real test. Its sibling probe already proves
// the semantics in the database — two polls between chunk completions return an identical payload, and a
// completion changes it. What was missing was the HTTP behaviour built on top, and this asserts exactly that
// against the route rather than against a helper.
//
// The LEGACY branch is exercised on purpose: a non-uuid job id skips the S-I3 durable read, so this needs no
// database at all. Both branches call the same `conditionalJson`, and the route comment records why both
// were wired.

import { beforeEach, describe, expect, mock, test } from "bun:test";

const SUB = "00000000-0000-0000-0000-000000000001";
const TID = "11111111-1111-1111-1111-111111111111";
const WID = "22222222-2222-2222-2222-222222222222";

/** The BullMQ job the legacy branch reads. Mutable so a test can move the progress and re-poll. */
let jobState = "active";
let jobProgress: unknown = {
  total: 100,
  processed: 10,
  created: 8,
  matched: 1,
  skipped: 1,
  failed: 0,
};

// Every export the module has, not just the two this test drives: a partial module mock breaks any OTHER
// importer with "export X not found", which is how the first version of this file failed.
mock.module("./queue.ts", () => ({
  importQueueHealth: async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
  enqueueImport: async () => "1",
  getImportJob: async () => ({
    id: "123",
    data: { scope: { tenantId: TID, workspaceId: WID }, importedByUserId: SUB },
    getState: async () => jobState,
    progress: jobProgress,
    returnvalue: null,
    failedReason: null,
  }),
}));

// Gate OFF ⇒ the legacy branch runs, which is the branch that needs no DB.
mock.module("./importV2Gate.ts", () => ({
  isImportV2Enabled: async () => false,
  isCopyModeEngaged: async () => false,
}));

// Unscoped viewer ⇒ the creator check is skipped; this test is about caching, not authz (authz has its own
// suites, and duplicating it here would couple two unrelated regressions to one file).
mock.module("../../middleware/jobViewer.ts", () => ({
  buildJobViewer: async () => ({ scoped: false, role: "owner", userId: SUB }),
}));

mock.module("../../middleware/authn.ts", () => ({
  authn: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("claims", { sub: SUB, tid: TID, wid: WID });
    await next();
  },
}));

const { app } = await import("../../app.ts");

async function poll(headers: Record<string, string> = {}): Promise<Response> {
  return app.request("/api/v1/imports/123", { headers });
}

describe("GET /imports/:jobId — conditional poll", () => {
  beforeEach(() => {
    jobState = "active";
    jobProgress = { total: 100, processed: 10, created: 8, matched: 1, skipped: 1, failed: 0 };
  });

  test("a first poll returns 200 with an ETag and the short private cache window", async () => {
    const res = await poll();
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
    // `private` matters as much as the age: this body is one workspace's import, and a shared cache holding
    // it would serve one tenant's progress to another.
    expect(res.headers.get("cache-control")).toBe("private, max-age=2");
  });

  test("re-polling an UNCHANGED job with If-None-Match returns 304 and no body", async () => {
    const first = await poll();
    const etag = first.headers.get("etag") ?? "";
    const second = await poll({ "if-none-match": etag });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    // The 304 must still carry the validator and the freshness policy, or the client's next request has no
    // ETag to send and silently falls back to unconditional GETs — undoing the saving while looking correct.
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("private, max-age=2");
  });

  test("when the job MOVES, the same If-None-Match returns 200 with a new ETag", async () => {
    const first = await poll();
    const etag = first.headers.get("etag") ?? "";

    // Progress advances. The shape must SATISFY importProgressSchema — the route safeParses it, and an
    // invalid fixture renders "progress: null" on BOTH polls, so the body never changes and the 304 is
    // correct. The first version of this test used a two-field progress object, got a 304 here, and would
    // have been "fixed" by weakening the route had the fixture not been checked first.
    jobProgress = { total: 100, processed: 90, created: 80, matched: 6, skipped: 4, failed: 0 };

    const after = await poll({ "if-none-match": etag });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    // And the body really is the new one, not a stale replay.
    expect(await after.text()).toContain("90");
  });

  test("a stale ETag from an earlier state does not suppress the current body", async () => {
    // The failure this guards is the expensive one: a client pinned to an old body, told it is current, with
    // no error anywhere to notice.
    const stale = '"definitely-not-the-current-entity"';
    const res = await poll({ "if-none-match": stale });
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(0);
  });
});
