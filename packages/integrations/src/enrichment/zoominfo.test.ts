// zoominfo.test.ts — the ZoomInfo adapter on recorded payloads (14 §3.5: no live spend, no credentials in
// CI). Two things are worth proving here and both bit us on the linkedin_api lane: the response ENVELOPE
// (a vendor shape change must not silently zero the hit rate) and the AUTH seam (a minted token, so an
// unconfigured or failing vendor is a quiet miss rather than a throw into the waterfall).
// The auth module is exercised through injected seams — never `mock.module`, which is process-global in bun
// and leaks into every other suite.

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { EnrichRequest } from "@leadwolf/core";
import type { EnrichField } from "@leadwolf/types";
import { type FetchJson, vendorProvider } from "./httpProvider.ts";
import {
  extractZoominfo,
  zoominfoHeaders,
  zoominfoMatchBody,
  zoominfoProvider,
} from "./providers.ts";
import {
  buildClientAssertion,
  parseTokenResponse,
  zoominfoCredentialState,
  zoominfoToken,
} from "./zoominfoAuth.ts";

const FIELDS: EnrichField[] = ["email", "phone", "jobTitle", "seniorityLevel", "department"];

const REQUEST: EnrichRequest = {
  workspaceId: "11111111-1111-1111-1111-111111111111",
  entityType: "contact",
  fields: FIELDS,
  subject: {
    fullName: "Jane Q Doe",
    companyDomain: "acme.com",
    companyName: "Acme",
    linkedinUrl: "https://www.linkedin.com/in/janedoe",
  },
};

// Enterprise shape: data.result[].data[] with a sibling matchStatus.
const ENTERPRISE_HIT = {
  data: {
    result: [
      {
        matchStatus: "FULL_MATCH",
        data: [
          {
            id: 12345,
            email: "jane@acme.com",
            phone: "+1 617 555 0142",
            jobTitle: "VP Engineering",
            managementLevel: ["VP Level Executives"],
            jobFunction: [{ name: "Engineering", department: "Engineering & Technical" }],
          },
        ],
      },
    ],
  },
};

// GTM shape (what we call): data[].attributes with meta.matchStatus.
const V1_HIT = {
  data: [
    {
      id: "9876",
      type: "Contact",
      attributes: {
        email: "jane@acme.com",
        mobilePhone: "+1 617 555 0199",
        jobTitle: "VP Engineering",
        managementLevel: "VP Level Executives",
        jobFunction: "Engineering & Technical",
        company: { id: 12, name: "Acme" },
      },
      meta: { matchStatus: "FULL_MATCH", input: {} },
    },
  ],
};

const fixtureFetch =
  (status: number, json: unknown): FetchJson =>
  () =>
    Promise.resolve({ status, json });

describe("extractZoominfo", () => {
  test("reads the Enterprise data.result[].data[] envelope", () => {
    expect(extractZoominfo(ENTERPRISE_HIT, FIELDS)).toEqual({
      email: "jane@acme.com",
      phone: "+1 617 555 0142",
      jobTitle: "VP Engineering",
      seniorityLevel: "VP Level Executives",
      department: "Engineering & Technical",
    });
  });

  test("reads the GTM data[].attributes envelope, falling back to mobilePhone", () => {
    expect(extractZoominfo(V1_HIT, FIELDS)).toEqual({
      email: "jane@acme.com",
      phone: "+1 617 555 0199",
      jobTitle: "VP Engineering",
      seniorityLevel: "VP Level Executives",
      department: "Engineering & Technical",
    });
  });

  test("a declared non-match yields no fields even when the record carries values", () => {
    const noMatch = {
      data: {
        result: [{ matchStatus: "NO_MATCH", data: [{ email: "someone.else@acme.com" }] }],
      },
    };
    expect(extractZoominfo(noMatch, FIELDS)).toEqual({});
  });

  test("every non-match GTM status is refused — only FULL/PARTIAL_MATCH lets values through", () => {
    for (const status of [
      "NO_MATCH",
      "NON_MATCH_BY_REQUIRED_FIELDS",
      "OPT_OUT",
      "LIMIT_EXCEEDED",
      "SOMETHING_NEW",
    ]) {
      const payload = {
        data: [
          {
            type: "Contact",
            attributes: { email: "someone.else@acme.com" },
            meta: { matchStatus: status },
          },
        ],
      };
      expect(extractZoominfo(payload, FIELDS)).toEqual({});
    }
    const partial = {
      data: [
        {
          type: "Contact",
          attributes: { email: "jane@acme.com" },
          meta: { matchStatus: "PARTIAL_MATCH" },
        },
      ],
    };
    expect(extractZoominfo(partial, ["email"])).toEqual({ email: "jane@acme.com" });
  });

  test("a NoMatch entry never supplies the record", () => {
    const mixed = {
      data: [
        { id: "0", type: "NoMatch", meta: { matchStatus: "NO_MATCH", input: {} } },
        {
          id: "1",
          type: "Contact",
          attributes: { email: "jane@acme.com" },
          meta: { matchStatus: "FULL_MATCH" },
        },
      ],
    };
    expect(extractZoominfo(mixed, ["email"])).toEqual({ email: "jane@acme.com" });
  });

  test("junk, empty and unknown shapes are a miss, never a throw", () => {
    for (const payload of [null, 42, "nope", {}, { data: {} }, { data: [] }, { data: null }]) {
      expect(extractZoominfo(payload, FIELDS)).toEqual({});
    }
  });

  test("only the requested fields come back", () => {
    expect(extractZoominfo(ENTERPRISE_HIT, ["email"])).toEqual({ email: "jane@acme.com" });
  });
});

describe("zoominfoProvider", () => {
  test("a 200 hit maps to the port contract and charges the call", async () => {
    const provider = zoominfoProvider(fixtureFetch(200, ENTERPRISE_HIT));
    // The real resolver reports unconfigured in CI, so drive the spec directly with a stub token to
    // prove the mapping; the unconfigured path is asserted separately below.
    const withToken = vendorProvider(
      {
        name: "zoominfo",
        trust: 0.85,
        costMicrosPerCall: 60_000,
        url: "https://api.zoominfo.com/enrich/contact",
        apiKey: undefined,
        resolveApiKey: () => Promise.resolve("stub-jwt"),
        headers: (jwt) => ({ authorization: `Bearer ${jwt}` }),
        body: () => ({}),
        extract: extractZoominfo,
      },
      fixtureFetch(200, ENTERPRISE_HIT),
    );
    const result = await withToken.enrich(REQUEST);
    expect(result.status).toBe("hit");
    expect(result.costMicros).toBe(60_000);
    expect(result.fields.find((f) => f.field === "email")?.value).toBe("jane@acme.com");
    expect(provider.name).toBe("zoominfo");
  });

  test("wraps the match batch in the GTM ContactEnrich envelope", () => {
    const body = zoominfoMatchBody(REQUEST);
    expect(body.data.type).toBe("ContactEnrich");
    const input = body.data.attributes.matchPersonInput[0];
    expect(input?.firstName).toBe("Jane");
    expect(input?.lastName).toBe("Q Doe");
    expect(input?.fullName).toBe("Jane Q Doe");
    expect(input?.externalURL).toBe("https://www.linkedin.com/in/janedoe");
    expect(input?.companyName).toBe("Acme");
    expect(body.data.attributes.outputFields).toContain("mobilePhone");
    expect(body.data.attributes.outputFields).toContain("managementLevel");
    // requiredFields must stay absent: it makes ZoomInfo WITHHOLD partially-populated records.
    expect("requiredFields" in body.data.attributes).toBe(false);
  });

  test("asks for the JSON:API media type — plain application/json is a 406 from the gateway", () => {
    const headers = zoominfoHeaders("tok");
    expect(headers.accept).toBe("application/vnd.api+json");
    expect(headers.authorization).toBe("Bearer tok");
  });

  test("falls back to the company domain when no company name is known", () => {
    const body = zoominfoMatchBody({ ...REQUEST, subject: { companyDomain: "acme.com" } });
    expect(body.data.attributes.matchPersonInput[0]?.companyName).toBe("acme.com");
  });

  test("a one-token or absent name never invents a surname", () => {
    expect(
      zoominfoMatchBody({ ...REQUEST, subject: { fullName: "Prince" } }).data.attributes
        .matchPersonInput[0],
    ).toMatchObject({ firstName: "Prince", lastName: undefined });
    const empty = zoominfoMatchBody({ ...REQUEST, subject: {} }).data.attributes
      .matchPersonInput[0];
    expect(empty?.firstName).toBeUndefined();
    expect(empty?.lastName).toBeUndefined();
  });

  test("no credentials ⇒ zero-cost miss and no outbound call", async () => {
    let called = false;
    const spy: FetchJson = () => {
      called = true;
      return Promise.resolve({ status: 200, json: ENTERPRISE_HIT });
    };
    const result = await zoominfoProvider(spy).enrich(REQUEST);
    expect(zoominfoCredentialState()).toBe("unconfigured");
    expect(result.status).toBe("miss");
    expect(result.costMicros).toBe(0);
    expect(called).toBe(false);
  });

  test("a failing token resolver is a quiet miss, not a throw", async () => {
    const provider = vendorProvider(
      {
        name: "zoominfo",
        trust: 0.85,
        costMicrosPerCall: 60_000,
        url: "https://api.zoominfo.com/enrich/contact",
        apiKey: undefined,
        resolveApiKey: () => Promise.reject(new Error("authenticate 401")),
        headers: (jwt) => ({ authorization: `Bearer ${jwt}` }),
        body: () => ({}),
        extract: extractZoominfo,
      },
      fixtureFetch(200, ENTERPRISE_HIT),
    );
    const result = await provider.enrich(REQUEST);
    expect(result.status).toBe("miss");
    expect(result.costMicros).toBe(0);
  });
});

describe("zoominfoAuth", () => {
  test("parses the OAuth client-credentials response and honours expires_in", () => {
    const now = 1_700_000_000_000;
    const parsed = parseTokenResponse(
      { access_token: "abc.def.ghi", expires_in: 3600, token_type: "Bearer", scope: "api:data" },
      now,
    );
    expect(parsed).toEqual({ token: "abc.def.ghi", expiresAtMs: now + 3_600_000 });
  });

  test("parses the legacy { jwt } response, reading its own exp", () => {
    const exp = Math.floor(1_700_000_000_000 / 1000) + 1800;
    const body = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    const parsed = parseTokenResponse({ jwt: `h.${body}.sig` }, 1_700_000_000_000);
    expect(parsed?.expiresAtMs).toBe(exp * 1000);
  });

  test("a response with no token at all is null, not a bogus token", () => {
    for (const body of [null, {}, { access_token: "" }, { jwt: 42 }, { error: "invalid_client" }]) {
      expect(parseTokenResponse(body, 1)).toBeNull();
    }
  });

  test("unconfigured mints nothing", async () => {
    expect(
      await zoominfoToken(() => Promise.resolve({ status: 200, json: { jwt: "x" } })),
    ).toBeNull();
  });

  test("the PKI assertion is a real RS256 JWT over the account's key", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const assertion = buildClientAssertion(
      "ops@truepoint.in",
      "0oaTESTCLIENT",
      pem,
      1_700_000_000_000,
    );
    const [header, payload, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
    expect(claims.iss).toBe("0oaTESTCLIENT");
    expect(claims.sub).toBe("ops@truepoint.in");
    expect(claims.exp - claims.iat).toBe(300);
    expect((signature ?? "").length).toBeGreaterThan(300); // 2048-bit signature, base64url
  });
});
