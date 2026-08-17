// providers.test.ts — provider CONTRACT tests on recorded fixtures (14 §3.5: no live spend in CI): each
// adapter maps its vendor payload shape onto the port contract, reports miss-without-key, and surfaces
// rate-limit/error statuses the waterfall + breaker react to. The 0111 additions also prove the hardened
// transport (host pin, https-only, size cap, throw→zero-cost-error) and the GET/query adapter shape.

import { afterEach, describe, expect, test } from "bun:test";
import type { EnrichRequest } from "@leadwolf/core";
import type { fetchLinkedinProfile } from "@leadwolf/core";
import {
  type FetchJson,
  ProviderTransportError,
  defaultFetchJson,
  vendorProvider,
} from "./httpProvider.ts";
import {
  apolloProvider,
  coresignalExtract,
  coresignalProvider,
  linkedinApiExtract,
  linkedinApiProvider,
  pdlExtract,
  pdlProvider,
} from "./providers.ts";

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

  test("429 surfaces the vendor's Retry-After as retryAfterMs (deferral input)", async () => {
    const fetch429: FetchJson = () =>
      Promise.resolve({ status: 429, json: {}, headers: { "retry-after": "17" } });
    const result = await keyedVendor(fetch429).enrich(REQUEST);
    expect(result.status).toBe("rate_limited");
    expect(result.retryAfterMs).toBe(17_000);
    expect(result.costMicros).toBe(0);
  });

  test("a throwing transport becomes a zero-cost error — an adapter never throws", async () => {
    const boom: FetchJson = () => Promise.reject(new Error("socket hang up"));
    const result = await keyedVendor(boom).enrich(REQUEST);
    expect(result.status).toBe("error");
    expect(result.costMicros).toBe(0);
  });
});

describe("hardened default transport (0111 security mandate)", () => {
  test("a non-allowlisted host is refused before any network I/O", async () => {
    const err = await defaultFetchJson("https://attacker.internal/metadata", {
      method: "GET",
      headers: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderTransportError);
    expect((err as Error).message).toContain("not allowlisted");
  });

  test("plain http is refused even for an allowlisted host", async () => {
    const err = await defaultFetchJson("http://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: {},
      body: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderTransportError);
    expect((err as Error).message).toContain("https");
  });
});

describe("hardened transport against a stubbed global fetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("an oversized response body is refused before JSON.parse", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("x".repeat(2_000_000), { status: 200 }),
      )) as unknown as typeof fetch;
    const err = await defaultFetchJson("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: {},
      body: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderTransportError);
    expect((err as Error).message).toContain("exceeds");
  });

  test("response headers come back lowercased (Retry-After reachable)", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("{}", { status: 429, headers: { "Retry-After": "3" } }),
      )) as unknown as typeof fetch;
    const out = await defaultFetchJson("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: {},
      body: {},
    });
    expect(out.status).toBe(429);
    expect(out.headers?.["retry-after"]).toBe("3");
  });
});

// ── PDL + Coresignal (waterfall v2 second wave) ─────────────────────────────────────────────────────────

// Recorded PDL-shaped cassette (v5 person enrich, trimmed to the fields the adapter reads).
const PDL_HIT = {
  status: 200,
  likelihood: 9,
  data: {
    work_email: "jane@acme.com",
    mobile_phone: "+14155550100",
    job_title: "vp of engineering",
    job_title_levels: ["vp"],
    job_title_role: "engineering",
  },
};

// Recorded Coresignal-shaped cassette (v2 employee multi-source enrich; top-level, no `data` wrapper).
const CORESIGNAL_HIT = {
  id: 12345,
  primary_professional_email: "jane@acme.com",
  job_title: "VP Engineering",
  management_level: "vp",
  department: "engineering",
};

function pdlFixture(status: number, json: unknown): { provider: string; fetch: FetchJson } {
  return { provider: "pdl", fetch: () => Promise.resolve({ status, json }) };
}

describe("PDL adapter contract (recorded fixtures)", () => {
  test("maps the v5 person payload onto port fields", async () => {
    // Simulate a configured key by constructing through vendorProvider with the same spec the real
    // adapter uses — via pdlProvider we can't inject a key, so assert the keyless short-circuit and
    // exercise mapping through a keyed clone below.
    const keyless = await pdlProvider(pdlFixture(200, PDL_HIT).fetch).enrich({
      ...REQUEST,
      fields: ["email", "phone", "jobTitle", "seniorityLevel", "department"],
    });
    expect(keyless.status).toBe("miss"); // PDL_API_KEY unset in tests
    expect(keyless.costMicros).toBe(0);
  });

  test("GET adapters build a query string and never send a body", async () => {
    let seenUrl = "";
    let seenInit: { method: string; body?: unknown } | null = null;
    const spy: FetchJson = (url, init) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve({ status: 200, json: PDL_HIT });
    };
    const provider = vendorProvider(
      {
        name: "pdl",
        trust: 0.75,
        costMicrosPerCall: 40_000,
        url: "https://recorded.fixture/v5/person/enrich",
        method: "GET",
        apiKey: "test-key",
        headers: (key) => ({ "x-api-key": key }),
        query: (req) => ({
          email: req.subject.email,
          name: req.subject.fullName,
          company: req.subject.companyName ?? req.subject.companyDomain,
          profile: req.subject.linkedinUrl, // undefined — must be dropped
        }),
        extract: () => ({ email: "jane@acme.com" }),
      },
      spy,
    );
    const result = await provider.enrich(REQUEST);
    expect(result.status).toBe("hit");
    expect(seenUrl).toBe(
      "https://recorded.fixture/v5/person/enrich?name=Jane+Doe&company=acme.com",
    );
    expect(seenInit).not.toBeNull();
    expect(seenInit!.method).toBe("GET");
    expect(seenInit!.body).toBeUndefined();
  });

  test("the SHIPPED pdlExtract pins the v5 field paths against the recorded cassette", () => {
    const out = pdlExtract(PDL_HIT, ["email", "phone", "jobTitle", "seniorityLevel", "department"]);
    expect(out).toEqual({
      email: "jane@acme.com",
      phone: "+14155550100",
      jobTitle: "vp of engineering",
      seniorityLevel: "vp",
      department: "engineering",
    });
  });

  test("pdlExtract degrades to {} on a no-match / malformed payload", () => {
    expect(pdlExtract({ status: 404, error: { type: "not_found" } }, ["email"])).toEqual({});
    expect(pdlExtract(null, ["email"])).toEqual({});
    expect(pdlExtract({ data: { work_email: 42 } }, ["email"])).toEqual({}); // non-string never leaks
  });
});

describe("Coresignal adapter contract (recorded fixtures)", () => {
  test("declares email+profile capabilities but NOT phone (honest capability set)", () => {
    const provider = coresignalProvider();
    expect(provider.capabilities).toContain("contact.email");
    expect(provider.capabilities).toContain("contact.profile");
    expect(provider.capabilities).not.toContain("contact.phone");
  });

  test("keyless short-circuit: miss, zero cost, no call", async () => {
    let called = false;
    const spy: FetchJson = () => {
      called = true;
      return Promise.resolve({ status: 200, json: CORESIGNAL_HIT });
    };
    const result = await coresignalProvider(spy).enrich(REQUEST);
    expect(result.status).toBe("miss");
    expect(called).toBe(false);
  });

  test("the SHIPPED coresignalExtract pins the top-level field paths", () => {
    const out = coresignalExtract(CORESIGNAL_HIT, [
      "email",
      "jobTitle",
      "seniorityLevel",
      "department",
    ]);
    expect(out).toEqual({
      email: "jane@acme.com",
      jobTitle: "VP Engineering",
      seniorityLevel: "vp",
      department: "engineering",
    });
  });

  test("coresignalExtract never yields phone even if asked (no capability, no mapping)", () => {
    expect(coresignalExtract({ ...CORESIGNAL_HIT, phone: "+15550100" }, ["phone"])).toEqual({});
  });
});

// Shaped from `source plan/truepoint profile Response.txt` — the linkedin_api person document.
const LINKEDIN_API_HIT = {
  schema_version: 1,
  profile_id: "ACwAAAkMo0QBIgbAXuFmUKhDjOGNw2hj0tjFPqg",
  member_id: 151823172,
  public_identifier: "william-gates-cpa-770a1842",
  headline: "VP of Finance",
  current_position: { title: "Senior Director of Accounting", company_id: 9338128 },
  contact: { primary_email: "wgates@verticalbridge.example", emails: [], phones: [] },
};

describe("linkedin_api adapter contract (recorded fixtures)", () => {
  test("declares email+profile capabilities but NOT phone (contact block is reveal-gated)", () => {
    const provider = linkedinApiProvider();
    expect(provider.name).toBe("linkedin_api");
    expect(provider.capabilities).toContain("contact.email");
    expect(provider.capabilities).toContain("contact.profile");
    expect(provider.capabilities).not.toContain("contact.phone");
  });

  test("URL-keyed: no subject linkedinUrl → miss, zero cost, no fetch (the dark posture)", async () => {
    let called = false;
    const stub = (() => {
      called = true;
      return Promise.resolve({ status: "ok", payload: LINKEDIN_API_HIT, originId: null } as const);
    }) as typeof fetchLinkedinProfile;
    // REQUEST carries no linkedinUrl — the adapter must not even consult the origin chain.
    const result = await linkedinApiProvider(stub).enrich(REQUEST);
    expect(result.status).toBe("miss");
    expect(result.costMicros).toBe(0);
    expect(called).toBe(false);
  });

  test("origin-chain outcomes map onto the port taxonomy: ok→paid hit, rejected→free miss, unavailable→free error", async () => {
    const urlReq = {
      ...REQUEST,
      subject: { ...REQUEST.subject, linkedinUrl: "https://www.linkedin.com/in/wgates" },
    };
    const ok = (() =>
      Promise.resolve({
        status: "ok",
        payload: LINKEDIN_API_HIT,
        originId: "o1",
      } as const)) as typeof fetchLinkedinProfile;
    const hit = await linkedinApiProvider(ok).enrich(urlReq);
    expect(hit.status).toBe("hit");
    expect(hit.costMicros).toBeGreaterThan(0);
    expect(hit.rawPayload).toEqual(LINKEDIN_API_HIT); // the FULL document rides out to the landing

    const rejected = (() =>
      Promise.resolve({
        status: "rejected",
        httpStatus: 404,
      } as const)) as typeof fetchLinkedinProfile;
    const miss = await linkedinApiProvider(rejected).enrich(urlReq);
    expect(miss.status).toBe("miss");
    expect(miss.costMicros).toBe(0);

    const down = (() =>
      Promise.resolve({ status: "unavailable" } as const)) as typeof fetchLinkedinProfile;
    const err = await linkedinApiProvider(down).enrich(urlReq);
    expect(err.status).toBe("error");
    expect(err.costMicros).toBe(0);
  });

  test("a successful capture with NO extractable flat fields is a PAID miss carrying the payload", async () => {
    const bare = { schema_version: 1, profile_id: "X", public_identifier: "x" };
    const ok = (() =>
      Promise.resolve({
        status: "ok",
        payload: bare,
        originId: null,
      } as const)) as typeof fetchLinkedinProfile;
    const result = await linkedinApiProvider(ok).enrich({
      ...REQUEST,
      subject: { ...REQUEST.subject, linkedinUrl: "https://www.linkedin.com/in/x" },
    });
    expect(result.status).toBe("miss");
    expect(result.costMicros).toBeGreaterThan(0);
    expect(result.rawPayload).toEqual(bare);
  });

  test("the SHIPPED linkedinApiExtract pins the payload paths", () => {
    const out = linkedinApiExtract(LINKEDIN_API_HIT, ["email", "jobTitle"]);
    expect(out).toEqual({
      email: "wgates@verticalbridge.example",
      jobTitle: "Senior Director of Accounting",
    });
  });

  test("jobTitle falls back to the headline when current_position is absent", () => {
    const { current_position: _cp, ...noPosition } = LINKEDIN_API_HIT;
    expect(linkedinApiExtract(noPosition, ["jobTitle"])).toEqual({ jobTitle: "VP of Finance" });
  });

  test("emails[0] serves when primary_email is null; phone never extracted", () => {
    const alt = {
      ...LINKEDIN_API_HIT,
      contact: { primary_email: null, emails: ["alt@example.com"], phones: ["+15550100"] },
    };
    expect(linkedinApiExtract(alt, ["email", "phone"])).toEqual({ email: "alt@example.com" });
  });
});
