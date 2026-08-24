// sandbox.test.ts — the playground simulator, held to the published contract.
//
// The playground's whole value is that what it shows equals what the reference documents and the service
// ships. Each test below encodes one behaviour straight out of endpoints/company.ts + endpoints/shared.ts;
// if the simulator drifts from the contract, this file is what says so. The fixture rules (fabricated
// records on reserved domains, ADR-0048 §D5) are asserted here too, beside the code they govern.

import { describe, expect, test } from "bun:test";
import { buildCurl, normaliseDomain, simulate } from "./sandbox.ts";
import type { SandboxRequest } from "./sandbox.ts";
import { SANDBOX_API_KEY, SANDBOX_RECORDS, SANDBOX_SAMPLES } from "./sandboxRecords.ts";

function request(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    endpoint: "match",
    apiKey: SANDBOX_API_KEY,
    domain: "northgate.example.com",
    idempotencyKey: "",
    balance: 100,
    replays: {},
    records: SANDBOX_RECORDS,
    ...overrides,
  };
}

describe("domain normalisation matches what the reference promises", () => {
  test("full URL, www. prefix and mixed case all normalise", () => {
    expect(normaliseDomain("https://www.Northgate.example.com/pricing")).toBe(
      "northgate.example.com",
    );
  });
  test("not domain-shaped → null", () => {
    expect(normaliseDomain("not a domain")).toBeNull();
    expect(normaliseDomain("")).toBeNull();
  });
});

describe("authentication", () => {
  test("any key without the tp_live_ band answers the same 401 invalid_token, nothing charged", () => {
    for (const apiKey of ["", "wrong", "tp_test_abc"]) {
      const outcome = simulate(request({ apiKey, endpoint: "enrich" }));
      expect(outcome.status).toBe(401);
      expect((outcome.body as { code: string }).code).toBe("invalid_token");
      expect(outcome.chargedCredits).toBe(0);
    }
  });
});

describe("validation", () => {
  test("unparseable domain → 422 validation_error, nothing charged", () => {
    const outcome = simulate(request({ domain: "???" }));
    expect(outcome.status).toBe(422);
    expect((outcome.body as { code: string }).code).toBe("validation_error");
    expect(outcome.chargedCredits).toBe(0);
  });
});

describe("match is free and a miss is an outcome, not an error", () => {
  test("hit → 200 matched:true with name+domain only, credits_charged 0", () => {
    const outcome = simulate(request());
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({
      matched: true,
      company: { domain: "northgate.example.com", name: "Northgate Tax Partners" },
      credits_charged: 0,
    });
    expect(outcome.chargedCredits).toBe(0);
  });
  test("miss → 200 matched:false company:null, credits_charged 0 (never a 404)", () => {
    const outcome = simulate(request({ domain: "meridian.example.com" }));
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ matched: false, company: null, credits_charged: 0 });
  });
});

describe("enrich billing", () => {
  test("hit charges exactly one credit and reports the remaining balance", () => {
    const outcome = simulate(request({ endpoint: "enrich", balance: 5 }));
    expect(outcome.status).toBe(200);
    expect(outcome.chargedCredits).toBe(1);
    const body = outcome.body as { credits_charged: number; credits_remaining: number };
    expect(body.credits_charged).toBe(1);
    expect(body.credits_remaining).toBe(4);
  });
  test("miss on enrich charges nothing", () => {
    const outcome = simulate(
      request({ endpoint: "enrich", domain: "meridian.example.com", balance: 5 }),
    );
    expect(outcome.status).toBe(200);
    expect(outcome.chargedCredits).toBe(0);
  });
  test("zero balance → 402 insufficient_credits carrying balance and required", () => {
    const outcome = simulate(request({ endpoint: "enrich", balance: 0 }));
    expect(outcome.status).toBe(402);
    const body = outcome.body as { code: string; balance: number; required: number };
    expect(body.code).toBe("insufficient_credits");
    expect(body.balance).toBe(0);
    expect(body.required).toBe(1);
    expect(outcome.chargedCredits).toBe(0);
  });
});

describe("idempotency", () => {
  test("a successful enrich with a key asks to be stored under it", () => {
    const outcome = simulate(request({ endpoint: "enrich", idempotencyKey: "idem-1" }));
    expect(outcome.storeKey).toBe("idem-1");
  });
  test("a retry with a stored key replays the stored response and charges nothing", () => {
    const first = simulate(request({ endpoint: "enrich", idempotencyKey: "idem-1", balance: 5 }));
    const retry = simulate(
      request({
        endpoint: "enrich",
        idempotencyKey: "idem-1",
        balance: 4,
        replays: { "idem-1": { status: first.status, body: first.body } },
      }),
    );
    expect(retry.replayed).toBe(true);
    expect(retry.chargedCredits).toBe(0);
    expect(retry.body).toEqual(first.body);
    expect(retry.storeKey).toBeNull();
  });
  test("match ignores replays entirely — idempotency is a billable-endpoint concern", () => {
    const outcome = simulate(
      request({
        idempotencyKey: "idem-1",
        replays: { "idem-1": { status: 200, body: { stale: true } } },
      }),
    );
    expect(outcome.replayed).toBe(false);
    expect((outcome.body as { matched: boolean }).matched).toBe(true);
  });
});

describe("the curl preview is the request the form composed", () => {
  test("match: GET with the key and the raw (un-normalised) domain", () => {
    const curl = buildCurl({
      endpoint: "match",
      apiKey: SANDBOX_API_KEY,
      domain: "https://www.Northgate.example.com/pricing",
      idempotencyKey: "",
    });
    expect(curl).toContain("curl -G");
    expect(curl).toContain(`Bearer ${SANDBOX_API_KEY}`);
    expect(curl).toContain("domain=https://www.Northgate.example.com/pricing");
  });
  test("enrich: POST carries the Idempotency-Key header only when one is set", () => {
    const base = { endpoint: "enrich" as const, apiKey: "", domain: "", idempotencyKey: "" };
    expect(buildCurl(base)).not.toContain("Idempotency-Key");
    expect(buildCurl({ ...base, idempotencyKey: "idem-1" })).toContain("Idempotency-Key: idem-1");
    expect(buildCurl(base)).toContain("$TRUEPOINT_API_KEY");
  });
});

describe("fixtures are fabricated (ADR-0048 §D5)", () => {
  const RESERVED = /(?:^|\.)example\.(?:com|net|org)$/;
  test("every record lives on a reserved domain", () => {
    for (const [domain, record] of Object.entries(SANDBOX_RECORDS)) {
      expect(domain).toMatch(RESERVED);
      expect(record.domain).toBe(domain);
      expect(new URL(record.website_url).hostname).toMatch(RESERVED);
    }
  });
  test("every sample chip resolves to a reserved domain", () => {
    for (const sample of SANDBOX_SAMPLES) {
      const domain = normaliseDomain(sample);
      expect(domain).not.toBeNull();
      expect(domain as string).toMatch(RESERVED);
    }
  });
  test("the sandbox key is shaped like a key and labelled as fake", () => {
    expect(SANDBOX_API_KEY.startsWith("tp_live_")).toBe(true);
    expect(SANDBOX_API_KEY).toContain("not_a_real_key");
  });
});
