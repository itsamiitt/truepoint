// sourceErrorClassifier.test.ts — the full classification matrix (expo.truepoint.in/docs §Errors &
// classifications), table-driven, plus the bare-status generic-vendor rows and the precedence rules.

import { describe, expect, test } from "bun:test";
import { type SourceErrorVerdict, classifySourceError } from "./sourceErrorClassifier.ts";

describe("classifySourceError — expo classification table", () => {
  const CASES: Array<{
    classification: string;
    httpStatus: number;
    expected: SourceErrorVerdict["kind"];
    scope?: "request" | "origin";
  }> = [
    { classification: "VALIDATION", httpStatus: 400, expected: "permanent", scope: "request" },
    {
      classification: "LINKEDIN_VALIDATION",
      httpStatus: 400,
      expected: "permanent",
      scope: "request",
    },
    {
      classification: "LINKEDIN_BAD_URL",
      httpStatus: 400,
      expected: "permanent",
      scope: "request",
    },
    { classification: "REQUEST_ERROR", httpStatus: 422, expected: "provider_miss" },
    { classification: "LINKEDIN_NOT_FOUND", httpStatus: 404, expected: "provider_miss" },
    { classification: "AUTH", httpStatus: 401, expected: "permanent", scope: "origin" },
    { classification: "FORBIDDEN", httpStatus: 403, expected: "permanent", scope: "origin" },
    { classification: "CLIENT_RATE_LIMITED", httpStatus: 429, expected: "throttled" },
    { classification: "QUEUE_FULL", httpStatus: 503, expected: "throttled" },
    { classification: "QUEUE_TIMEOUT", httpStatus: 503, expected: "throttled" },
    { classification: "LINKEDIN_THROTTLED", httpStatus: 429, expected: "throttled" },
    { classification: "LINKEDIN_QUEUE_FULL", httpStatus: 503, expected: "throttled" },
    { classification: "POOL_DEAD", httpStatus: 503, expected: "source_down" },
    { classification: "SHUTDOWN", httpStatus: 503, expected: "source_down" },
    { classification: "LINKEDIN_SESSION_INVALID", httpStatus: 502, expected: "source_down" },
    { classification: "LINKEDIN_NO_SESSION", httpStatus: 503, expected: "source_down" },
    { classification: "LINKEDIN_ENGINE_UNAVAILABLE", httpStatus: 503, expected: "source_down" },
    { classification: "SERVER_ERROR", httpStatus: 502, expected: "transient" },
    { classification: "UNKNOWN", httpStatus: 502, expected: "transient" },
    { classification: "LINKEDIN_UPSTREAM", httpStatus: 502, expected: "transient" },
    { classification: "LINKEDIN_CAPTURE_TIMEOUT", httpStatus: 504, expected: "transient" },
  ];

  for (const c of CASES) {
    test(`${c.classification} → ${c.expected}${c.scope ? `(${c.scope})` : ""}`, () => {
      const verdict = classifySourceError({
        httpStatus: c.httpStatus,
        classification: c.classification,
      });
      expect(verdict.kind).toBe(c.expected);
      if (c.scope && verdict.kind === "permanent") expect(verdict.scope).toBe(c.scope);
      expect(verdict.reason).toContain(c.classification);
    });
  }

  test("classification WINS over a contradicting bare status", () => {
    // A throttle class on a 200 envelope must classify as throttled, not fall to 2xx rules.
    expect(classifySourceError({ httpStatus: 200, classification: "QUEUE_FULL" }).kind).toBe(
      "throttled",
    );
  });

  test("classification match is case/whitespace-insensitive", () => {
    expect(classifySourceError({ httpStatus: 503, classification: " pool_dead " }).kind).toBe(
      "source_down",
    );
  });

  test("an UNKNOWN classification string degrades to bare-status semantics", () => {
    expect(classifySourceError({ httpStatus: 503, classification: "BRAND_NEW_CLASS" }).kind).toBe(
      "transient",
    );
    expect(classifySourceError({ httpStatus: 429, classification: "BRAND_NEW_CLASS" }).kind).toBe(
      "throttled",
    );
  });
});

describe("classifySourceError — Retry-After precedence and defaults", () => {
  test("an explicit Retry-After wins over every class default", () => {
    const throttled = classifySourceError({
      httpStatus: 429,
      classification: "CLIENT_RATE_LIMITED",
      retryAfterMs: 7_000,
    });
    expect(throttled).toMatchObject({ kind: "throttled", retryAfterMs: 7_000 });
    const poolDead = classifySourceError({
      httpStatus: 503,
      classification: "POOL_DEAD",
      retryAfterMs: 12_000,
    });
    expect(poolDead).toMatchObject({ kind: "source_down", cooldownMs: 12_000 });
  });

  test("class defaults when no Retry-After: throttle 15s, SHUTDOWN 30s, POOL_DEAD 300s, seat 600s", () => {
    expect(classifySourceError({ httpStatus: 503, classification: "QUEUE_FULL" })).toMatchObject({
      retryAfterMs: 15_000,
    });
    expect(classifySourceError({ httpStatus: 503, classification: "SHUTDOWN" })).toMatchObject({
      cooldownMs: 30_000,
    });
    expect(classifySourceError({ httpStatus: 503, classification: "POOL_DEAD" })).toMatchObject({
      cooldownMs: 300_000,
    });
    expect(
      classifySourceError({ httpStatus: 503, classification: "LINKEDIN_NO_SESSION" }),
    ).toMatchObject({ cooldownMs: 600_000 });
  });

  test("injected defaults (the env knobs) override the built-ins", () => {
    const verdict = classifySourceError(
      { httpStatus: 503, classification: "QUEUE_FULL" },
      { throttleFallbackMs: 2_000 },
    );
    expect(verdict).toMatchObject({ kind: "throttled", retryAfterMs: 2_000 });
  });
});

describe("classifySourceError — bare-status generic-vendor rows", () => {
  test("429 → throttled; 401/403 → permanent(origin); 404/422 → provider_miss; 5xx → transient", () => {
    expect(classifySourceError({ httpStatus: 429 }).kind).toBe("throttled");
    expect(classifySourceError({ httpStatus: 401 })).toMatchObject({
      kind: "permanent",
      scope: "origin",
    });
    expect(classifySourceError({ httpStatus: 403 })).toMatchObject({
      kind: "permanent",
      scope: "origin",
    });
    expect(classifySourceError({ httpStatus: 404 }).kind).toBe("provider_miss");
    expect(classifySourceError({ httpStatus: 422 }).kind).toBe("provider_miss");
    expect(classifySourceError({ httpStatus: 500 }).kind).toBe("transient");
    expect(classifySourceError({ httpStatus: 502 }).kind).toBe("transient");
  });

  test("no status at all (transport failure) → transient, reason carries the error", () => {
    const verdict = classifySourceError({ transportError: "fetch timed out" });
    expect(verdict.kind).toBe("transient");
    expect(verdict.reason).toBe("fetch timed out");
  });
});
