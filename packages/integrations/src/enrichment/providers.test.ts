// providers.test.ts — provider CONTRACT tests on recorded fixtures (14 §3.5: no live spend in CI): each
// adapter maps its vendor payload shape onto the port contract, reports miss-without-key, and surfaces
// rate-limit/error statuses the waterfall + breaker react to.

import { describe, expect, test } from "bun:test";
import type { EnrichRequest } from "@leadwolf/core";
import { type FetchJson, vendorProvider } from "./httpProvider.ts";
import { apolloProvider } from "./providers.ts";

const REQUEST: EnrichRequest = {
  workspaceId: "11111111-1111-1111-1111-111111111111",
  entityType: "contact",
  fields: ["email", "jobTitle"],
  subject: { fullName: "Jane Doe", companyDomain: "acme.com" },
};

// Recorded Apollo-shaped cassette (trimmed to the fields the adapter reads).
const APOLLO_HIT = {
  person: { email: "jane@acme.com", title: "VP Engineering", seniority: "vp" },
};

const fixtureFetch =
  (status: number, json: unknown): FetchJson =>
  () =>
    Promise.resolve({ status, json });

function keyedVendor(fetchJson: FetchJson) {
  return vendorProvider(
    {
      name: "apollo",
      trust: 0.8,
      costMicrosPerCall: 30_000,
      url: "https://recorded.fixture/people/match",
      apiKey: "test-key",
      headers: (key) => ({ "x-api-key": key }),
      body: () => ({}),
      extract: (json, fields) => {
        const person = (json as typeof APOLLO_HIT | null)?.person;
        if (!person) return {};
        const out: Record<string, string> = {};
        if (fields.includes("email") && person.email) out.email = person.email;
        if (fields.includes("jobTitle") && person.title) out.jobTitle = person.title;
        return out;
      },
    },
    fetchJson,
  );
}

describe("enrichment provider contract (recorded fixtures)", () => {
  test("a hit maps the vendor payload onto port fields + records the call cost", async () => {
    const result = await keyedVendor(fixtureFetch(200, APOLLO_HIT)).enrich(REQUEST);
    expect(result.status).toBe("hit");
    expect(result.costMicros).toBe(30_000);
    expect(result.fields).toEqual([
      { field: "email", value: "jane@acme.com" },
      { field: "jobTitle", value: "VP Engineering" },
    ]);
    expect(result.rawPayload).toEqual(APOLLO_HIT);
  });

  test("an empty payload is a paid miss; 429/5xx surface as rate_limited/error with no cost", async () => {
    expect((await keyedVendor(fixtureFetch(200, { person: null })).enrich(REQUEST)).status).toBe(
      "miss",
    );
    expect((await keyedVendor(fixtureFetch(429, {})).enrich(REQUEST)).status).toBe("rate_limited");
    expect((await keyedVendor(fixtureFetch(500, {})).enrich(REQUEST)).status).toBe("error");
    expect((await keyedVendor(fixtureFetch(500, {})).enrich(REQUEST)).costMicros).toBe(0);
  });

  test("a missing API key reports miss without ever calling the vendor", async () => {
    let called = false;
    const spyFetch: FetchJson = () => {
      called = true;
      return Promise.resolve({ status: 200, json: APOLLO_HIT });
    };
    // env.APOLLO_API_KEY is unset in tests → the real adapter must short-circuit.
    const result = await apolloProvider(spyFetch).enrich(REQUEST);
    expect(result.status).toBe("miss");
    expect(result.costMicros).toBe(0);
    expect(called).toBe(false);
  });
});
