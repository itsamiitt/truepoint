// bodyLimits.test.ts — the request-body policy contract (launch-scale Phase 1 finding, fixed post-S8):
// the /api-wide 2 MB default 413s oversized bodies as problem+json BEFORE authn, while the import-upload
// verbs are exempt from the default (their admission envelope applies instead) — the exact behaviour the
// old server-global Bun cap made impossible. Exercised through the REAL composed app (app.fetch).

import { describe, expect, test } from "bun:test";
import { IMPORT_UPLOAD_REQUEST_MAX_BYTES } from "@leadwolf/core";
import { app } from "../app.ts";
import { DEFAULT_API_BODY_LIMIT_BYTES } from "./bodyLimits.ts";

const big = DEFAULT_API_BODY_LIMIT_BYTES + 1;

function post(path: string, contentLength: number): Promise<Response> {
  // Content-Length alone is enough: hono/body-limit rejects on the header before reading a byte, so the
  // test never allocates the oversized body.
  return Promise.resolve(
    app.fetch(
      new Request(`http://api.test${path}`, {
        method: "POST",
        headers: { "content-length": String(contentLength), "content-type": "application/json" },
        body: "{}",
      }),
    ),
  );
}

describe("api body limits", () => {
  test("an oversized body on a normal /api route 413s as problem+json (pre-authn)", async () => {
    const res = await post("/api/v1/search/count", big);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; status: number };
    expect(body.code).toBe("payload_too_large");
    expect(body.status).toBe(413);
  });

  test("the import-upload verbs are exempt from the 2 MB default", async () => {
    for (const path of ["/api/v1/imports", "/api/v1/imports/preview", "/api/v1/imports/rows"]) {
      const res = await post(path, big);
      // The limiter's own contract is all this may assert: NOT rejected for size. What happens next
      // (401 standalone) is authn's business — and other suite files mock.module auth process-globally
      // (the known bun leak, see memory/bun-mock-module-leaks-globally), so an exact downstream status
      // here would couple this test to suite ordering.
      expect(res.status).not.toBe(413);
    }
  });

  test("the import verbs still enforce their own envelope", async () => {
    const res = await post("/api/v1/imports", IMPORT_UPLOAD_REQUEST_MAX_BYTES + 1);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("payload_too_large");
  });

  test("a normal-sized body on a normal route passes the limiter", async () => {
    const res = await post("/api/v1/search/count", 2);
    // Same leak-tolerance as above: the limiter must not fire; the downstream status belongs to authn.
    expect(res.status).not.toBe(413);
  });
});
