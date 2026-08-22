// shippedContract.test.ts — the documented contract, checked against the code that serves it.
//
// WHY THIS EXISTS. Reading these pages against `apps/api` by hand turned up four defects in a single sitting:
// a quickstart teaching a request body the endpoint rejects, examples attaching fabricated firmographics to a
// real domain, a backoff instruction naming a header the API never sends, and a provenance block published in
// a shape the store does not hold. Every one of them was invisible in review, because each page was internally
// consistent and sounded authoritative. A documentation site cannot be kept honest by proofreading; it stays
// honest when disagreeing with the code is a failing test.
//
// HOW IT READS THE CODE. By TEXT, with `fs`, never by import. `apps/doc` may import `@leadwolf/ui` and
// `@leadwolf/app-shell` and nothing else — the `doc-app-holds-no-data-path` dependency-cruiser rule is what
// lets this site build with zero environment and makes it structurally incapable of causing a data incident
// (ADR-0048 §D2). Importing `apps/api` here to compare types would trade that property for convenience. A
// file read in a test creates no module edge, and `contrast.test.ts` already established the pattern.
//
// The parses are narrow and each one asserts it found something before comparing. A regex that silently
// matched nothing would turn this file into a suite that passes because it checked nothing at all — which is
// the specific way a guard like this rots.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_ENRICH, COMPANY_MATCH } from "./endpoints/company.ts";
import { COMMON_ERRORS } from "./endpoints/shared.ts";

const API_ROOT = join(import.meta.dir, "..", "..", "..", "api", "src");

/** Line endings are normalised on read: the repo carries CRLF on Windows checkouts, and a pattern written
 *  with \n would fail here for a reason that has nothing to do with the contract. */
function apiSource(relative: string): string {
  return readFileSync(join(API_ROOT, relative), "utf8").replace(/\r\n/g, "\n");
}

const SERIALIZE = apiSource("features/public-api/serialize.ts");
const ROUTES = apiSource("features/public-api/companyRoutes.ts");
/** Scope enforcement lives in the auth middleware, not the routes — so its codes are searched there too. */
const KEY_AUTH = apiSource("features/public-api/apiKeyAuth.ts");
/** The generic 500 is built by the error renderer rather than thrown as an AppError, so `internal` is only
 *  spelled there — the one documented code that exists in neither the type package nor the routes. */
const ERROR_RENDERER = apiSource("middleware/error.ts");
const ERRORS = apiSource(join("..", "..", "..", "packages", "types", "src", "errors.ts"));

/** The documented `company.*` return field names for one endpoint, without the prefix. */
function documentedCompanyFields(endpoint: typeof COMPANY_ENRICH): string[] {
  return endpoint.returns
    .filter((field) => field.name.startsWith("company."))
    .map((field) => field.name.slice("company.".length));
}

describe("the response we document is the response the code builds", () => {
  /** The declared wire shape — the interface IS the allow-list, per serialize.ts's own comment. */
  const payloadFields = (() => {
    const block =
      /export interface PublicCompanyPayload \{([\s\S]*?)\n\}/.exec(SERIALIZE)?.[1] ?? "";
    return [...block.matchAll(/^\s{2}([a-z_]+)\??:/gm)].map((match) => match[1] as string);
  })();

  test("the parse found the payload interface", () => {
    // Guards the guard: if serialize.ts is restructured and this regex stops matching, every comparison
    // below would trivially pass against an empty list.
    expect(payloadFields.length).toBeGreaterThan(5);
    expect(payloadFields).toContain("domain");
  });

  test("company enrichment documents exactly the fields the serializer emits", () => {
    expect([...documentedCompanyFields(COMPANY_ENRICH)].sort()).toEqual([...payloadFields].sort());
  });

  test("company match documents only what its route actually returns", () => {
    // The match route builds `{ domain, name }` inline rather than through the serializer, so it is the
    // route body that has to agree — and the whole point of match is that it returns nothing else.
    const shape = /company: \{ domain: row\.primaryDomain, name: row\.name \}/.test(ROUTES);
    expect(shape).toBe(true);
    expect([...documentedCompanyFields(COMPANY_MATCH)].sort()).toEqual(["domain", "name"]);
  });

  test("nothing deliberately withheld from the wire is documented as returned", () => {
    const omitted =
      /INTENTIONALLY_OMITTED_COMPANY_FIELDS = \[([\s\S]*?)\] as const/.exec(SERIALIZE)?.[1] ?? "";
    const names = [...omitted.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1] as string);
    expect(names.length).toBeGreaterThan(0);

    const documented = [
      ...documentedCompanyFields(COMPANY_ENRICH),
      ...documentedCompanyFields(COMPANY_MATCH),
    ];
    for (const internal of names) {
      // The omitted list is camelCase (internal column names); compare against the snake_case wire names.
      const wire = internal.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      expect(documented).not.toContain(wire);
    }
  });
});

describe("the endpoints we document are the endpoints that are mounted", () => {
  test("both documented company paths exist as routes", () => {
    expect(ROUTES).toContain('publicCompanyRoutes.get("/match"');
    expect(ROUTES).toContain('publicCompanyRoutes.post("/enrich"');
  });

  test("each one requires the scope its page publishes", () => {
    // /docs and the OpenAPI document both say search:read. A route mounted without it would make the docs
    // describe a permission model the service does not enforce.
    expect(ROUTES).toContain('publicCompanyRoutes.get("/match", requireScope("search:read")');
    expect(ROUTES).toContain('publicCompanyRoutes.post("/enrich", requireScope("search:read")');
  });

  test("the billable one is mounted behind idempotency", () => {
    // The published promise is that a retry with the same key cannot double-charge. That is only true if the
    // middleware is actually on the route.
    expect(ROUTES).toMatch(/post\("\/enrich",\s*requireScope\("search:read"\),\s*idempotency/);
  });
});

describe("the error vocabulary we publish is the one the platform speaks", () => {
  test("every documented code is a code the platform can emit", () => {
    // AppError subclasses declare their `code` as a string literal; requireScope and the routes raise the
    // rest. Both files are searched, so a documented code that exists nowhere fails here.
    const emitted = `${ERRORS}\n${ROUTES}\n${KEY_AUTH}\n${ERROR_RENDERER}`;
    for (const error of COMMON_ERRORS) {
      expect(emitted).toContain(`"${error.code}"`);
    }
  });

  test("the no-match outcome is a 200, in the code as well as on the page", () => {
    // The single most consequential thing these pages say. If this ever became a 404, every integration
    // following our own advice to branch on `matched` would start treating coverage gaps as outages.
    expect(ROUTES).toContain("matched: false, company: null, credits_charged: 0");
    expect(COMPANY_MATCH.billing).toContain("matched:false");
  });

  test("a documented free endpoint is free in the code", () => {
    expect(COMPANY_MATCH.credits).toBe(0);
    expect(ROUTES).toContain('endpoint: "company.match",\n      billed: false,');
  });

  test("the billable endpoint's cost comes from configuration, not a page", () => {
    // The docs say one credit; the route reads env.API_COST_COMPANY_ENRICH, whose default is 1. Asserting
    // the SOURCE rather than the number is what keeps this from breaking every time a default is tuned —
    // what must never happen is the route hardcoding a cost that silently disagrees with the page.
    expect(ROUTES).toContain("env.API_COST_COMPANY_ENRICH");
    expect(COMPANY_ENRICH.credits).toBeGreaterThan(0);
  });
});
