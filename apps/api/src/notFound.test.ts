// notFound.test.ts — the unmatched-route response is part of the API contract, not an afterthought.
//
// Every other error this service produces is RFC-9457 problem+json. Before this handler existed, a 404 fell
// through to Hono's plain-text default — so the ONE response a client is most likely to hit by accident (a
// typo'd path, a removed endpoint, a stale SDK pinned to a route that moved) was the single response that
// broke the envelope. A client whose error path branches on `problem.code` got an unparseable body exactly
// when it needed to branch (audit 32 · C4).
//
// This suite calls the handler directly rather than booting the app: app.ts imports every feature router,
// which drags in @leadwolf/db and @leadwolf/config at module load. The handler is the whole contract here,
// and testing it in isolation keeps this a true unit test.

import { describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { notFound } from "./middleware/error.ts";

/** The two Context members the handler touches. */
function fakeContext(requestId?: string): Context {
  const headers = new Headers();
  return {
    get: (key: string) => (key === "requestId" ? requestId : undefined),
    header: (name: string, value: string) => headers.set(name, value),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: {
          ...Object.fromEntries(headers),
          "content-type": headers.get("content-type") ?? "",
        },
      }),
  } as unknown as Context;
}

describe("unmatched routes", () => {
  test("answer with problem+json, not plain text", async () => {
    const res = notFound(fakeContext("req-abc"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe(404);
    expect(body.code).toBe("not_found");
    expect(body.title).toBe("Not found");
    expect(typeof body.type).toBe("string");
  });

  test("echo the request id so a report can be joined to a log line", async () => {
    const body = (await notFound(fakeContext("req-abc")).json()) as Record<string, unknown>;
    expect(body.requestId).toBe("req-abc");
  });

  test("omit requestId entirely when there is none — never emit null", async () => {
    // A null in a problem document is worse than an absent key: a client that renders "Reference: null"
    // has shown the user a value that does not exist.
    const body = (await notFound(fakeContext(undefined).valueOf() as Context).json()) as Record<
      string,
      unknown
    >;
    expect("requestId" in body).toBe(false);
  });

  test("the type URI has no doubled separator", async () => {
    // ERROR_TYPE_BASE_URL already carries its trailing separator — the 500 branch relies on the same thing.
    // A leading slash here would produce '…//not-found', which is a different URI than the one documented.
    const body = (await notFound(fakeContext()).json()) as { type: string };
    expect(body.type).not.toContain("//not-found");
    expect(body.type.endsWith("not-found")).toBe(true);
  });
});
