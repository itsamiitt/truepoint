// The vendor's wire format is an ENVELOPE ({success, data, meta}); every contract downstream — the zod
// payload schemas, the mapper, the content hash — is defined over the DOCUMENT. Getting this wrong is
// invisible at runtime (the fetch 200s, the parse fails, and the registry used to record success), so the
// peel is pinned here. Tested as a PURE function: no module mocks, because `mock.module` is process-global
// in bun and leaks into every other test file in the run.
//
// walkOriginChain is tested the same way — exported with injected deps (fake transport, fake cooldown
// store on a fake clock, recordOutcome spy), so the failover/cooldown semantics run hermetically.

import { describe, expect, test } from "bun:test";
import {
  type ChainDeps,
  type LinkedinTransport,
  unwrapEnvelope,
  walkOriginChain,
} from "./linkedinSourceClient.ts";
import { makeOriginCooldownStore } from "./originCooldowns.ts";
import type { ResolvedOrigin } from "./originRouter.ts";

const PERSON = { schema_version: 1, profile_id: "ACwAA1", public_identifier: "fkamal2" };

describe("vendor envelope", () => {
  test("unwraps {success, data} to the document", () => {
    const out = unwrapEnvelope({
      success: true,
      data: PERSON,
      meta: { captured_at: "2026-08-12T09:14:02.117Z", engine: "browser" },
    });
    expect(out).toEqual({ kind: "ok", payload: PERSON });
  });

  test("a bare document (no envelope) still works", () => {
    expect(unwrapEnvelope(PERSON)).toEqual({ kind: "ok", payload: PERSON });
  });

  test("success:false WITHOUT a classification is a REJECTED request — no origin would answer differently", () => {
    expect(unwrapEnvelope({ success: false, error: "not found" })).toEqual({
      kind: "rejected",
      httpStatus: 200,
    });
  });

  test("success:false WITH a throttle classification cools-and-fails-over instead of poisoning the registry", () => {
    const out = unwrapEnvelope(
      { success: false, error: "queue full", classification: "QUEUE_FULL" },
      5_000,
    );
    expect(out).toMatchObject({ kind: "cooled", cooldownMs: 5_000, throttled: true });
  });

  test("success:false with a MISS classification stays rejected (an honest no-match)", () => {
    expect(
      unwrapEnvelope({ success: false, error: "no match", classification: "REQUEST_ERROR" }).kind,
    ).toBe("rejected");
  });

  test("success:true with no data object fails the attempt rather than landing junk", () => {
    const out = unwrapEnvelope({ success: true, data: null });
    expect(out.kind).toBe("transient");
  });

  test("a company envelope peels the same way", () => {
    const company = { schema_version: 2, company_id: 296229, name: "Otsuka" };
    expect(unwrapEnvelope({ success: true, data: company, meta: {} })).toEqual({
      kind: "ok",
      payload: company,
    });
  });
});

// ── walkOriginChain — failover, cooldowns, Retry-After ────────────────────────────────────────────────

const PATH = "/api/linkedin/profile" as const;
const BODY = {
  url: "https://www.linkedin.com/in/x",
  include_raw: false,
  refresh: false,
  engine: "auto",
};

function origin(id: string): ResolvedOrigin {
  return {
    id,
    baseUrl: `https://${id}.example.com`,
    host: `${id}.example.com`,
    apiKey: `key-${id}`,
  };
}

type CannedResponse = { status: number; json: unknown; headers?: Record<string, string> };

/** Scripted transport: answers per-origin (by host), counting calls. */
function scriptedTransport(
  byHost: Record<string, CannedResponse | (() => CannedResponse) | Error>,
) {
  const calls: string[] = [];
  const transport: LinkedinTransport = (url) => {
    const host = new URL(url).host;
    calls.push(host);
    const canned = byHost[host];
    if (canned === undefined) throw new Error(`unscripted host: ${host}`);
    if (canned instanceof Error) return Promise.reject(canned);
    return Promise.resolve(typeof canned === "function" ? canned() : canned);
  };
  return { transport, calls };
}

function harness(nowRef: { now: number }, overrides: Partial<ChainDeps> = {}) {
  const cooldowns = makeOriginCooldownStore(() => nowRef.now);
  const outcomes: Array<{ originId: string | null; ok: boolean; error?: string }> = [];
  const deps: ChainDeps = {
    cooldowns,
    recordOutcome: (originId, ok, error) => {
      outcomes.push({ originId, ok, ...(error !== undefined ? { error } : {}) });
      return Promise.resolve();
    },
    transientRetries: 0,
    transientRetryDelayMs: 1,
    jitter: (ms) => ms,
    sleep: () => Promise.resolve(),
    ...overrides,
  };
  return { cooldowns, outcomes, deps };
}

const OK: CannedResponse = { status: 200, json: { success: true, data: PERSON } };

describe("walkOriginChain", () => {
  test("429 + Retry-After cools the origin for exactly the header and fails over NOW", async () => {
    const nowRef = { now: 1_000_000 };
    const { cooldowns, outcomes, deps } = harness(nowRef);
    const { transport, calls } = scriptedTransport({
      "o1.example.com": {
        status: 429,
        json: { success: false, classification: "CLIENT_RATE_LIMITED", correlation_id: "cid-1" },
        headers: { "retry-after": "42" },
      },
      "o2.example.com": OK,
    });

    const result = await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, transport, deps);

    expect(result).toEqual({ status: "ok", payload: PERSON, originId: "o2" });
    expect(calls).toEqual(["o1.example.com", "o2.example.com"]);
    expect(cooldowns.cooling("o1")).toEqual({
      cooling: true,
      remainingMs: 42_000,
      throttled: true,
    });
    // The failure detail lands in provider_origins.last_error via recordOutcome.
    expect(outcomes[0]).toMatchObject({ originId: "o1", ok: false });
    expect(outcomes[0]?.error).toContain("[CLIENT_RATE_LIMITED]");
    expect(outcomes[0]?.error).toContain("cid=cid-1");
    expect(outcomes[1]).toMatchObject({ originId: "o2", ok: true });
  });

  test("a cooling origin is SKIPPED on the next walk — zero requests spent on it", async () => {
    const nowRef = { now: 1_000_000 };
    const { deps } = harness(nowRef);
    const throttling = scriptedTransport({
      "o1.example.com": { status: 429, json: {}, headers: { "retry-after": "60" } },
      "o2.example.com": OK,
    });
    await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, throttling.transport, deps);

    const second = scriptedTransport({ "o2.example.com": OK });
    const result = await walkOriginChain(
      [origin("o1"), origin("o2")],
      PATH,
      BODY,
      second.transport,
      deps,
    );
    expect(result.status).toBe("ok");
    expect(second.calls).toEqual(["o2.example.com"]); // o1 never touched while cooling
  });

  test("AUTH on one origin fails over (misconfigured key ≠ bad request) and cools that origin long", async () => {
    const nowRef = { now: 0 };
    const { cooldowns, deps } = harness(nowRef);
    const { transport, calls } = scriptedTransport({
      "o1.example.com": { status: 401, json: { success: false, classification: "AUTH" } },
      "o2.example.com": OK,
    });
    const result = await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, transport, deps);
    expect(result.status).toBe("ok");
    expect(calls).toEqual(["o1.example.com", "o2.example.com"]);
    expect(cooldowns.cooling("o1").cooling).toBe(true);
  });

  test("VALIDATION stops the chain — the REQUEST is bad, no mirror will disagree; origin stays healthy", async () => {
    const nowRef = { now: 0 };
    const { outcomes, deps } = harness(nowRef);
    const { transport, calls } = scriptedTransport({
      "o1.example.com": { status: 400, json: { success: false, classification: "VALIDATION" } },
    });
    const result = await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, transport, deps);
    expect(result).toEqual({ status: "rejected", httpStatus: 400 });
    expect(calls).toEqual(["o1.example.com"]);
    expect(outcomes[0]).toMatchObject({ originId: "o1", ok: true });
  });

  test("a bare 404 (no classification) still stops the chain as an honest no-match", async () => {
    const nowRef = { now: 0 };
    const { deps } = harness(nowRef);
    const { transport } = scriptedTransport({
      "o1.example.com": { status: 404, json: null },
    });
    const result = await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, transport, deps);
    expect(result).toEqual({ status: "rejected", httpStatus: 404 });
  });

  test("POOL_DEAD honors its Retry-After as a long origin cooldown", async () => {
    const nowRef = { now: 0 };
    const { cooldowns, deps } = harness(nowRef);
    const { transport } = scriptedTransport({
      "o1.example.com": {
        status: 503,
        json: { success: false, classification: "POOL_DEAD" },
        headers: { "retry-after": "300" },
      },
      "o2.example.com": OK,
    });
    await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, transport, deps);
    expect(cooldowns.cooling("o1")).toEqual({
      cooling: true,
      remainingMs: 300_000,
      throttled: false,
    });
  });

  test("transient 502 gets ONE same-origin retry (deps.transientRetries), then fails over", async () => {
    const nowRef = { now: 0 };
    const sleeps: number[] = [];
    const { deps } = harness(nowRef, {
      transientRetries: 1,
      transientRetryDelayMs: 300,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const { transport, calls } = scriptedTransport({
      "o1.example.com": { status: 502, json: { success: false, classification: "SERVER_ERROR" } },
      "o2.example.com": OK,
    });
    const result = await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, transport, deps);
    expect(result.status).toBe("ok");
    expect(calls).toEqual(["o1.example.com", "o1.example.com", "o2.example.com"]);
    expect(sleeps).toEqual([300]);
  });

  test("a transport THROW is transient too — retried then failed over, never thrown out", async () => {
    const nowRef = { now: 0 };
    const { deps } = harness(nowRef, { transientRetries: 1 });
    const { transport, calls } = scriptedTransport({
      "o1.example.com": new Error("fetch failed"),
      "o2.example.com": OK,
    });
    const result = await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, transport, deps);
    expect(result.status).toBe("ok");
    expect(calls).toEqual(["o1.example.com", "o1.example.com", "o2.example.com"]);
  });

  test("ALL origins throttled → unavailable carrying the SMALLEST horizon, reason throttled", async () => {
    const nowRef = { now: 0 };
    const { deps } = harness(nowRef);
    const { transport } = scriptedTransport({
      "o1.example.com": { status: 429, json: {}, headers: { "retry-after": "120" } },
      "o2.example.com": { status: 429, json: {}, headers: { "retry-after": "30" } },
    });
    const result = await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, transport, deps);
    expect(result).toEqual({ status: "unavailable", retryAfterMs: 30_000, reason: "throttled" });
  });

  test("every origin already cooling → unavailable with the remaining horizon, ZERO requests; reason reflects the STORED throttled bit", async () => {
    const nowRef = { now: 0 };
    const { cooldowns, deps } = harness(nowRef);
    cooldowns.set("o1", 20_000, true); // cooled by a throttle
    cooldowns.set("o2", 50_000); // cooled by an outage/misconfig
    const { transport, calls } = scriptedTransport({});
    const result = await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, transport, deps);
    expect(result).toEqual({ status: "unavailable", retryAfterMs: 20_000, reason: "throttled" });
    expect(calls).toEqual([]);

    // A fleet cooled ONLY by outages must not report as throttled on later walks.
    cooldowns.reset();
    cooldowns.set("o1", 20_000);
    cooldowns.set("o2", 50_000);
    const again = await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, transport, deps);
    expect(again).toEqual({ status: "unavailable", retryAfterMs: 20_000, reason: "down" });
  });

  test("the REPORTED horizon is the vendor's own — only the STORED cooldown is clamped", async () => {
    const nowRef = { now: 0 };
    const { cooldowns, deps } = harness(nowRef);
    const { transport } = scriptedTransport({
      "o1.example.com": {
        status: 429,
        json: { success: false, classification: "LINKEDIN_THROTTLED" },
        headers: { "retry-after": "86400" }, // daily budget — a day
      },
    });
    const result = await walkOriginChain([origin("o1")], PATH, BODY, transport, deps);
    // Reported: the full 86400s, so the breaker horizon / park decision see the truth.
    expect(result).toEqual({
      status: "unavailable",
      retryAfterMs: 86_400_000,
      reason: "throttled",
    });
    // Stored: clamped to ENRICH_ORIGIN_COOLDOWN_MAX_MS (default 1h) so a bad header can't brick an origin.
    expect(cooldowns.cooling("o1").remainingMs).toBe(3_600_000);
  });

  test("all transient failures with no horizon → plain unavailable (no invented retryAfterMs)", async () => {
    const nowRef = { now: 0 };
    const { deps } = harness(nowRef);
    const { transport } = scriptedTransport({
      "o1.example.com": { status: 500, json: null },
      "o2.example.com": new Error("connection reset"),
    });
    const result = await walkOriginChain([origin("o1"), origin("o2")], PATH, BODY, transport, deps);
    expect(result).toEqual({ status: "unavailable" });
  });

  test("success CLEARS a lapsed cooldown state and records the origin healthy", async () => {
    const nowRef = { now: 0 };
    const { cooldowns, outcomes, deps } = harness(nowRef);
    cooldowns.set("o1", 10_000);
    nowRef.now += 11_000; // horizon lapsed — the origin is probed again
    const { transport } = scriptedTransport({ "o1.example.com": OK });
    const result = await walkOriginChain([origin("o1")], PATH, BODY, transport, deps);
    expect(result.status).toBe("ok");
    expect(cooldowns.cooling("o1").cooling).toBe(false);
    expect(outcomes[0]).toMatchObject({ originId: "o1", ok: true });
  });
});
