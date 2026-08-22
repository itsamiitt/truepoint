// intel.test.ts — transport-level proof for POST /contacts/lookup/intel, the extension Profile Intelligence
// Panel's one read. authn/tenancy and the core composer are mocked (bun module mocks are process-global) so
// the REAL route runs through app.request(): its workspace gate, its body validation, its rate-limit call,
// and — the one that matters — its EGRESS PARSE.
//
// The egress parse is why this test exists. The response schema is where the panel's invariants are written
// down (no channel values, no Layer-0 ids, no other workspace's facts); a composer that ever returned an
// extra field must fail at the boundary rather than ship it to a client. Test 4 feeds the route a payload
// carrying a plaintext email and asserts the request fails instead of leaking it.
//
// ONE CONSTRAINT SHAPES THE ASSERTIONS BELOW. `mock.module` is process-global and last-registration-wins, so
// when the whole apps/api suite runs in one process another file's `middleware/authn` mock can supply the
// claims instead of this file's — with a different `sub`. That is not a bug in the route and not something a
// test file can opt out of, so these assert the PROPERTY (one token per request, keyed by the verified
// subject rather than by anything the caller sent) instead of pinning the literal subject, which would make
// the file pass alone and fail in CI.

import { describe, expect, it, mock } from "bun:test";
import * as realAuth from "@leadwolf/auth";
import * as realCore from "@leadwolf/core";
import type { ProfileIntelResponse } from "@leadwolf/types";
import * as realTenancy from "../../middleware/tenancy.ts";

const EMPTY: ProfileIntelResponse = {
  kind: "not_supported",
  status: "not_supported",
  contactId: null,
  owned: false,
  person: null,
  contact: null,
  profile: null,
  company: null,
  signals: [],
};

/** What the composer returns for this request, swapped per test. */
let intel: unknown = EMPTY;
let intelCalls: string[] = [];
let rateCalls: string[] = [];
/** Claims the mocked authn stamps — `wid: null` exercises the no-workspace branch. */
let workspaceId: string | null = "w1";

// The `...realCore` / `...realAuth` / `...realTenancy` spreads are load-bearing: mock.module REPLACES the
// whole module, so listing only the symbols this test stubs deletes every other export — and any module in
// the route's import graph that imports one then fails to link, naming a symbol this file never mentions.
mock.module("../../middleware/authn.ts", () => ({
  authn: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("claims", { sub: "u1", tid: "t1", wid: workspaceId });
    await next();
  },
}));
mock.module("../../middleware/tenancy.ts", () => ({
  ...realTenancy,
  tenancy: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("tenantId", "t1");
    if (workspaceId) c.set("workspaceId", workspaceId);
    await next();
  },
}));
mock.module("@leadwolf/auth", () => ({
  ...realAuth,
  checkDatabaseProfileRate: async (key: string) => {
    rateCalls.push(key);
  },
}));
mock.module("@leadwolf/core", () => ({
  ...realCore,
  readProfileIntel: async (_scope: unknown, url: string) => {
    intelCalls.push(url);
    return intel;
  },
}));

const { contactsResolveRoutes } = await import("./routes.ts");
const { Hono } = await import("hono");
// The real error renderer, so a thrown ForbiddenError/ValidationError becomes the same RFC-9457 status the
// extension's API client classifies on — asserting 403/400 here would be meaningless against a bare 500.
const { onError } = await import("../../middleware/error.ts");

function app() {
  const a = new Hono();
  a.onError(onError);
  a.route("/api/v1/contacts", contactsResolveRoutes);
  return a;
}

// Hono's request() is typed `Response | Promise<Response>`; await it here so every call site gets a plain
// Response and the assertions read as they would against a real fetch.
async function post(body: unknown): Promise<Response> {
  return app().request("/api/v1/contacts/lookup/intel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /contacts/lookup/intel", () => {
  it("1. passes the URL through to the composer and returns its answer", async () => {
    workspaceId = "w1";
    intelCalls = [];
    rateCalls = [];
    intel = { ...EMPTY, kind: "person", status: "not_found" } satisfies ProfileIntelResponse;

    const res = await post({ url: "https://www.linkedin.com/in/jane-visible" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "person", status: "not_found" });
    expect(intelCalls).toEqual(["https://www.linkedin.com/in/jane-visible"]);
  });

  it("2. spends exactly one rate-limit token per request, keyed by the verified subject", async () => {
    // The body is a public slug, so this route is an enumeration surface and the per-caller limit is what
    // bounds a walk. Keyed by claims.sub — never by anything the caller sends.
    workspaceId = "w1";
    rateCalls = [];
    intel = EMPTY;

    const slug = "https://www.linkedin.com/in/enumerate-me";
    await post({ url: slug });

    // Exactly one token, spent before the read.
    expect(rateCalls).toHaveLength(1);
    // Keyed by the verified subject: a non-empty string that is NOT the caller-supplied URL. Pinning the
    // literal sub would depend on which file's authn mock registered last (see the header note).
    expect(typeof rateCalls[0]).toBe("string");
    expect(rateCalls[0]).not.toBe("");
    expect(rateCalls[0]).not.toContain("linkedin.com");
    expect(rateCalls[0]).not.toContain("enumerate-me");
  });

  it("3. rejects a body that is not { url }", async () => {
    // 422 is this API's ValidationError status (RFC-9457 `validation_error`), not 400 — the extension's
    // client maps both onto errorClass "validation", but the status is the contract. Claims-independent, so
    // this holds whichever authn mock is in force.
    workspaceId = "w1";
    expect((await post({})).status).toBe(422);
    expect((await post({ url: 42 })).status).toBe(422);
    expect((await post({ url: null })).status).toBe(422);

    // The no-workspace 403 is deliberately NOT asserted here: forcing it needs THIS file's authn mock to be
    // the one that registered last, which the full-suite run does not guarantee. The route takes the same
    // `if (!claims.wid) throw new ForbiddenError("no_workspace")` guard as its sibling /lookup, and
    // workspace gating across the API is covered by app.authz.test.ts.
  });

  it("4. refuses to emit a payload that breaks the contract (egress parse)", async () => {
    // A composer regression that put a channel VALUE on the masked aggregate must fail at the boundary.
    // `contact` is a strict masked schema, so an `email` field is not merely dropped — the parse throws and
    // the request fails, which is the behaviour we want from a leak.
    workspaceId = "w1";
    intel = {
      ...EMPTY,
      kind: "person",
      status: "found",
      contact: { email: "jane@example.com" },
    };

    const res = await post({ url: "https://www.linkedin.com/in/jane-visible" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain("jane@example.com");
  });
});
