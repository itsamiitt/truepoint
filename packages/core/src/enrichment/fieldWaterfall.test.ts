// fieldWaterfall.test.ts — the waterfall-v2 per-field cascade invariants (0111; 06 §4 + the data-skill
// mandate). Hermetic: stub providers, in-memory breaker, pass-through/scripted gates and verifiers.

import { describe, expect, test } from "bun:test";
import type { EmailStatus } from "@leadwolf/types";
import { staticVerifier } from "../data-health/emailVerifier.ts";
import { formatOnlyPhoneVerifier } from "../data-health/phoneVerifier.ts";
import { inMemoryBreakerStore } from "./breakerStore.ts";
import { runFieldWaterfalls } from "./fieldWaterfall.ts";
import { type GateDecision, type ProviderGate, passThroughGate } from "./providerGate.ts";
import type { EnrichRequest, EnrichmentProvider, ProviderResult } from "./providerPort.ts";

const REQUEST: EnrichRequest = {
  workspaceId: "11111111-1111-1111-1111-111111111111",
  entityType: "contact",
  fields: ["email", "phone"],
  subject: { fullName: "Jane Doe", companyDomain: "acme.com" },
};

interface StubSpec {
  name: string;
  capabilities?: EnrichmentProvider["capabilities"];
  trust?: number;
  cost?: number;
  /** field → value this provider returns (a hit); {} = paid miss; "error"/"rate_limited" = that status. */
  answer: Partial<Record<string, string>> | "error" | "rate_limited";
}

function stub(spec: StubSpec): { provider: EnrichmentProvider; calls: () => number } {
  let calls = 0;
  const provider: EnrichmentProvider = {
    name: spec.name,
    capabilities: spec.capabilities ?? ["contact.email", "contact.phone", "contact.profile"],
    trust: spec.trust ?? 0.8,
    estimateCostMicros: () => spec.cost ?? 10_000,
    enrich(req): Promise<ProviderResult> {
      calls += 1;
      if (spec.answer === "error")
        return Promise.resolve({ fields: [], rawPayload: null, costMicros: 0, status: "error" });
      if (spec.answer === "rate_limited")
        return Promise.resolve({
          fields: [],
          rawPayload: null,
          costMicros: 0,
          status: "rate_limited",
          retryAfterMs: 5_000,
        });
      const fields = req.fields
        .filter((f) => typeof spec.answer !== "string" && spec.answer[f])
        .map((f) => ({ field: f, value: (spec.answer as Record<string, string>)[f] as string }));
      return Promise.resolve(
        fields.length > 0
          ? {
              fields,
              rawPayload: { from: spec.name },
              costMicros: spec.cost ?? 10_000,
              status: "hit",
            }
          : {
              fields: [],
              rawPayload: { from: spec.name },
              costMicros: spec.cost ?? 10_000,
              status: "miss",
            },
      );
    },
  };
  return { provider, calls: () => calls };
}

const NO_VERIFY = {
  verifyEmailBeforeAccept: false,
  acceptCatchAll: "flag" as const,
  verifyPhone: false,
};

function base(overrides: Partial<Parameters<typeof runFieldWaterfalls>[0]>) {
  return runFieldWaterfalls({
    providers: [],
    request: REQUEST,
    orderFor: () => [],
    breaker: inMemoryBreakerStore(),
    gate: passThroughGate,
    emailVerifier: staticVerifier({}),
    phoneVerifier: formatOnlyPhoneVerifier,
    policy: NO_VERIFY,
    ...overrides,
  });
}

describe("runFieldWaterfalls — per-field cascade", () => {
  test("email from A, phone from B — different fields resolve from different providers", async () => {
    const a = stub({ name: "a", answer: { email: "jane@acme.com" } });
    const b = stub({ name: "b", answer: { phone: "+14155550100" } });
    const out = await base({
      providers: [a.provider, b.provider],
      orderFor: () => ["a", "b"],
    });
    expect(out.winners.get("email")?.provider).toBe("a");
    expect(out.winners.get("phone")?.provider).toBe("b");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  test("one paid call per provider even when email and phone orders DIFFER", async () => {
    // Both providers can answer both fields; email order a→b, phone order b→a. Each is called ONCE.
    const a = stub({ name: "a", answer: { email: "jane@acme.com", phone: "+1111" } });
    const b = stub({ name: "b", answer: { email: "j@b.com", phone: "+2222" } });
    const out = await base({
      providers: [a.provider, b.provider],
      orderFor: (field) => (field === "email" ? ["a", "b"] : ["b", "a"]),
    });
    // email pass runs first and calls a (wins email); phone pass prefers b (fresh call), wins phone.
    expect(out.winners.get("email")?.provider).toBe("a");
    expect(out.winners.get("phone")?.provider).toBe("b");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    // a's memoized result also carried phone — but phone's order preferred b, so b's value won.
    expect(out.winners.get("phone")?.value).toBe("+2222");
  });

  test("a memoized earlier call satisfies a later field without a second spend", async () => {
    // a answers BOTH fields; order for both is a-first. a is called once; phone consumes the memo.
    const a = stub({ name: "a", answer: { email: "jane@acme.com", phone: "+1111" } });
    const b = stub({ name: "b", answer: { phone: "+2222" } });
    const out = await base({
      providers: [a.provider, b.provider],
      orderFor: () => ["a", "b"],
    });
    expect(out.winners.get("phone")?.provider).toBe("a");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(0); // never needed
    expect(out.attempts.filter((x) => x.provider === "a").length).toBe(1);
  });

  test("per-field early exit: a miss cascades, total cost = sum of ALL attempts", async () => {
    const a = stub({ name: "a", answer: {}, cost: 10_000 }); // paid miss
    const b = stub({ name: "b", answer: { email: "jane@acme.com" }, cost: 20_000 });
    const out = await base({
      providers: [a.provider, b.provider],
      orderFor: () => ["a", "b"],
      request: { ...REQUEST, fields: ["email"] },
    });
    expect(out.winners.get("email")?.provider).toBe("b");
    const total = out.attempts.reduce((s, x) => s + x.costMicros, 0);
    expect(total).toBe(30_000); // the miss still cost money and is still counted
  });

  test("capability filter: a phone-less provider is never called for phone", async () => {
    const emailOnly = stub({
      name: "coresignal-like",
      capabilities: ["contact.email", "contact.profile"],
      answer: { email: "jane@acme.com", phone: "+9999" }, // even if it WOULD answer, it is never asked
    });
    const phoneGuy = stub({ name: "p", answer: { phone: "+1111" } });
    const out = await base({
      providers: [emailOnly.provider, phoneGuy.provider],
      orderFor: () => ["coresignal-like", "p"],
    });
    expect(out.winners.get("email")?.provider).toBe("coresignal-like");
    expect(out.winners.get("phone")?.provider).toBe("p");
    // The email-pass call asked coresignal-like with the unfilled union, which INCLUDES phone at call
    // time — but the phone cascade itself never consults it: p is the first CAPABLE provider.
    expect(emailOnly.calls()).toBe(1);
  });

  test("filledFields lands on the WINNING attempt rows (the per-field cache coverage)", async () => {
    const a = stub({ name: "a", answer: { email: "jane@acme.com" } });
    const b = stub({ name: "b", answer: { phone: "+1111" } });
    const out = await base({
      providers: [a.provider, b.provider],
      orderFor: () => ["a", "b"],
    });
    expect(out.attempts.find((x) => x.provider === "a")?.filledFields).toEqual(["email"]);
    expect(out.attempts.find((x) => x.provider === "b")?.filledFields).toEqual(["phone"]);
  });
});

describe("runFieldWaterfalls — verify-before-accept (S-08)", () => {
  const VERIFY = {
    verifyEmailBeforeAccept: true,
    acceptCatchAll: "flag" as const,
    verifyPhone: false,
  };

  test("invalid cascades to the next provider; the winner carries its verdict", async () => {
    const a = stub({ name: "a", answer: { email: "dead@acme.com" } });
    const b = stub({ name: "b", answer: { email: "live@acme.com" } });
    const out = await base({
      providers: [a.provider, b.provider],
      orderFor: () => ["a", "b"],
      request: { ...REQUEST, fields: ["email"] },
      emailVerifier: staticVerifier({ "dead@acme.com": "invalid", "live@acme.com": "valid" }),
      policy: VERIFY,
    });
    expect(out.winners.get("email")?.provider).toBe("b");
    expect(out.winners.get("email")?.emailStatus).toBe("valid" satisfies EmailStatus);
    // Both the rejected candidate's verify and the winner's verify are ledgered.
    expect(out.attempts.filter((x) => x.provider.startsWith("verify:email:")).length).toBe(2);
  });

  test("catch_all under 'flag' (default): accepted WITH the true status persisted", async () => {
    const a = stub({ name: "a", answer: { email: "info@catchall.com" } });
    const out = await base({
      providers: [a.provider],
      orderFor: () => ["a"],
      request: { ...REQUEST, fields: ["email"] },
      emailVerifier: staticVerifier({ "info@catchall.com": "catch_all" }),
      policy: VERIFY,
    });
    expect(out.winners.get("email")?.emailStatus).toBe("catch_all");
  });

  test("catch_all under 'continue': cascades on, falls BACK to the catch-all when nothing verifies clean", async () => {
    const a = stub({ name: "a", answer: { email: "info@catchall.com" } });
    const b = stub({ name: "b", answer: {} }); // miss
    const out = await base({
      providers: [a.provider, b.provider],
      orderFor: () => ["a", "b"],
      request: { ...REQUEST, fields: ["email"] },
      emailVerifier: staticVerifier({ "info@catchall.com": "catch_all" }),
      policy: { ...VERIFY, acceptCatchAll: "continue" },
    });
    // b was tried (the cascade continued) but missed — the catch-all is better than nothing.
    expect(b.calls()).toBe(1);
    expect(out.winners.get("email")?.provider).toBe("a");
    expect(out.winners.get("email")?.emailStatus).toBe("catch_all");
  });

  test("catch_all under 'continue' is DISCARDED when a later provider verifies valid", async () => {
    const a = stub({ name: "a", answer: { email: "info@catchall.com" } });
    const b = stub({ name: "b", answer: { email: "live@acme.com" } });
    const out = await base({
      providers: [a.provider, b.provider],
      orderFor: () => ["a", "b"],
      request: { ...REQUEST, fields: ["email"] },
      emailVerifier: staticVerifier({
        "info@catchall.com": "catch_all",
        "live@acme.com": "valid",
      }),
      policy: { ...VERIFY, acceptCatchAll: "continue" },
    });
    expect(out.winners.get("email")?.provider).toBe("b");
    expect(out.winners.get("email")?.emailStatus).toBe("valid");
  });

  test("unknown is accepted (rejecting it would burn spend on SMTP-blocked domains)", async () => {
    const a = stub({ name: "a", answer: { email: "jane@blocked.com" } });
    const out = await base({
      providers: [a.provider],
      orderFor: () => ["a"],
      request: { ...REQUEST, fields: ["email"] },
      emailVerifier: staticVerifier({}, "unknown"),
      policy: VERIFY,
    });
    expect(out.winners.get("email")?.emailStatus).toBe("unknown");
  });

  test("a THROWING verifier = didn't run: candidate accepted, zero-cost error attempt ledgered", async () => {
    const a = stub({ name: "a", answer: { email: "jane@acme.com" } });
    const out = await base({
      providers: [a.provider],
      orderFor: () => ["a"],
      request: { ...REQUEST, fields: ["email"] },
      emailVerifier: {
        name: "broken",
        verify: () => Promise.reject(new Error("verifier down")),
      },
      policy: VERIFY,
    });
    expect(out.winners.get("email")?.provider).toBe("a");
    expect(out.winners.get("email")?.emailStatus).toBe("unverified");
    const verifyAttempt = out.attempts.find((x) => x.provider === "verify:email:a");
    expect(verifyAttempt?.status).toBe("error");
    expect(verifyAttempt?.costMicros).toBe(0);
  });

  test("verification spend is ledgered at verifyCostMicros", async () => {
    const a = stub({ name: "a", answer: { email: "jane@acme.com" } });
    const out = await base({
      providers: [a.provider],
      orderFor: () => ["a"],
      request: { ...REQUEST, fields: ["email"] },
      emailVerifier: staticVerifier({ "jane@acme.com": "valid" }),
      policy: VERIFY,
      verifyCostMicros: 1_500,
    });
    expect(out.attempts.find((x) => x.provider === "verify:email:a")?.costMicros).toBe(1_500);
  });
});

describe("runFieldWaterfalls — gate + breaker", () => {
  test("gate denial = synthetic zero-cost rate_limited attempt; provider never called", async () => {
    const a = stub({ name: "a", answer: { email: "jane@acme.com" } });
    const denyAll: ProviderGate = {
      allow: (): Promise<GateDecision> =>
        Promise.resolve({ allowed: false, reason: "rate_limited", retryAfterMs: 12_000 }),
      settle: () => Promise.resolve(),
    };
    const out = await base({
      providers: [a.provider],
      orderFor: () => ["a"],
      request: { ...REQUEST, fields: ["email"] },
      gate: denyAll,
    });
    expect(a.calls()).toBe(0);
    expect(out.attempts).toEqual([
      {
        provider: "a",
        status: "rate_limited",
        costMicros: 0,
        latencyMs: 0,
        filledFields: [],
        retryAfterMs: 12_000,
      },
    ]);
    expect(out.allThrottled).toBe(true);
    expect(out.retryAfterMs).toBe(12_000);
  });

  test("allThrottled is FALSE when any provider actually answered", async () => {
    const throttled = stub({ name: "t", answer: { email: "x@y.z" } });
    const answering = stub({ name: "b", answer: {} }); // paid miss
    const oneDenied: ProviderGate = {
      allow: (provider): Promise<GateDecision> =>
        provider === "t"
          ? Promise.resolve({ allowed: false, reason: "rate_limited" })
          : Promise.resolve({ allowed: true }),
      settle: () => Promise.resolve(),
    };
    const out = await base({
      providers: [throttled.provider, answering.provider],
      orderFor: () => ["t", "b"],
      request: { ...REQUEST, fields: ["email"] },
      gate: oneDenied,
    });
    expect(out.winners.size).toBe(0);
    expect(out.allThrottled).toBe(false);
  });

  test("a throwing gate fails CLOSED for that provider only (cascade continues)", async () => {
    const a = stub({ name: "a", answer: { email: "x@y.z" } });
    const b = stub({ name: "b", answer: { email: "jane@acme.com" } });
    const brokenForA: ProviderGate = {
      allow: (provider): Promise<GateDecision> =>
        provider === "a"
          ? Promise.reject(new Error("redis down"))
          : Promise.resolve({ allowed: true }),
      settle: () => Promise.resolve(),
    };
    const out = await base({
      providers: [a.provider, b.provider],
      orderFor: () => ["a", "b"],
      request: { ...REQUEST, fields: ["email"] },
      gate: brokenForA,
    });
    expect(a.calls()).toBe(0);
    expect(out.winners.get("email")?.provider).toBe("b");
  });

  test("an open breaker skips the provider without a synthetic attempt (it costs nothing, tells nothing new)", async () => {
    const failing = stub({ name: "f", answer: "error" });
    const backup = stub({ name: "b", answer: { email: "jane@acme.com" } });
    const breaker = inMemoryBreakerStore(1, 60_000); // threshold 1 for the test
    // Trip it.
    await breaker.record("f", false);
    const out = await base({
      providers: [failing.provider, backup.provider],
      orderFor: () => ["f", "b"],
      request: { ...REQUEST, fields: ["email"] },
      breaker,
    });
    expect(failing.calls()).toBe(0);
    expect(out.winners.get("email")?.provider).toBe("b");
    expect(out.attempts.some((x) => x.provider === "f")).toBe(false);
  });

  test("a throwing breaker READ fails OPEN — the provider is still called", async () => {
    const a = stub({ name: "a", answer: { email: "jane@acme.com" } });
    const out = await base({
      providers: [a.provider],
      orderFor: () => ["a"],
      request: { ...REQUEST, fields: ["email"] },
      breaker: {
        isOpen: () => Promise.reject(new Error("redis blip")),
        record: () => Promise.resolve(),
      },
    });
    expect(a.calls()).toBe(1);
    expect(out.winners.get("email")?.provider).toBe("a");
  });

  test("skipProviders (retry path): an already-answered provider is never re-called", async () => {
    const answered = stub({ name: "a", answer: { email: "jane@acme.com" } });
    const backup = stub({ name: "b", answer: { email: "j@b.com" } });
    const out = await base({
      providers: [answered.provider, backup.provider],
      orderFor: () => ["a", "b"],
      request: { ...REQUEST, fields: ["email"] },
      skipProviders: new Set(["a"]),
    });
    expect(answered.calls()).toBe(0); // paid on the prior run — never re-bought
    expect(out.winners.get("email")?.provider).toBe("b");
  });

  test("unknown provider names in the order are ignored (forward-compatible prefs)", async () => {
    const a = stub({ name: "a", answer: { email: "jane@acme.com" } });
    const out = await base({
      providers: [a.provider],
      orderFor: () => ["ghost-provider", "a"],
      request: { ...REQUEST, fields: ["email"] },
    });
    expect(out.winners.get("email")?.provider).toBe("a");
  });
});

describe("inMemoryBreakerStore", () => {
  test("opens after 3 consecutive failures; a miss/hit resets; half-open after cooldown", async () => {
    let clock = 1_000_000;
    const b = inMemoryBreakerStore(3, 60_000, () => clock);
    await b.record("p", false);
    await b.record("p", false);
    expect(await b.isOpen("p")).toBe(false);
    await b.record("p", false); // third consecutive → open
    expect(await b.isOpen("p")).toBe(true);
    clock += 59_999;
    expect(await b.isOpen("p")).toBe(true);
    clock += 1; // cooldown elapsed → half-open probe allowed
    expect(await b.isOpen("p")).toBe(false);
    await b.record("p", true); // probe succeeded → fully closed
    expect(await b.isOpen("p")).toBe(false);
  });
});
