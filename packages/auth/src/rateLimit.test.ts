// rateLimit.test.ts — the one branch in the rate limiter a unit test can reach, and the one that matters most.
//
// `rateLimit.ts` is the brute-force defence for the identifier/credential steps, OTP sends, reveals, captures
// and API keys. It had no test of any kind, and most of it cannot get one here: every limiter needs a live
// Redis, and this machine has none (`workspaceSwitch.itest.ts` fails the same way). Writing an itest that
// cannot be run locally would be worse than none — an unrun test is an assumption with a green tick.
//
// What IS reachable is the discrimination inside `consume`, and it is the part with real consequences.
// rate-limiter-flexible signals exhaustion by throwing a RateLimiterRes — a plain object carrying
// `msBeforeNext` — and signals a broken store by throwing an ordinary Error. Those two must go opposite ways:
//
//   rejection  → throw RateLimitedError  (the caller is genuinely out of points)
//   anything else → FAIL OPEN            (a Redis blip must not brick authentication)
//
// Both failure modes are silent. Treat an infra error as a rejection and a cache outage locks every user out
// of the product; treat a rejection as an infra error and an exhausted bucket quietly passes, which is an open
// door for credential stuffing. Neither logs anything unusual.
//
// The predicate and the retry-after arithmetic were extracted from the private `consume` for exactly this
// reason — the behaviour is unchanged, it is simply now addressable.

import { describe, expect, test } from "bun:test";
import { isRateLimitRejection, retryAfterSeconds } from "./rateLimit.ts";

describe("isRateLimitRejection — rejection versus infra failure", () => {
  test("a limiter rejection is recognised", () => {
    // The shape rate-limiter-flexible actually throws on exhaustion.
    expect(
      isRateLimitRejection({ msBeforeNext: 1500, remainingPoints: 0, consumedPoints: 31 }),
    ).toBe(true);
    expect(isRateLimitRejection({ msBeforeNext: 0 })).toBe(true);
  });

  test("an infra error is NOT a rejection — this is what keeps the fail-open path open", () => {
    expect(isRateLimitRejection(new Error("Redis connection lost"))).toBe(false);
    expect(isRateLimitRejection(new TypeError("boom"))).toBe(false);
  });

  test("null and undefined do not crash the check", () => {
    // `typeof null === "object"`, so the null guard is load-bearing: without it this throws inside a catch
    // block, turning a Redis outage into an unhandled error on the auth path.
    expect(isRateLimitRejection(null)).toBe(false);
    expect(isRateLimitRejection(undefined)).toBe(false);
  });

  test("primitives thrown by anything else are not rejections", () => {
    expect(isRateLimitRejection("msBeforeNext")).toBe(false);
    expect(isRateLimitRejection(1500)).toBe(false);
    expect(isRateLimitRejection(true)).toBe(false);
  });

  test("an object without the field is not a rejection", () => {
    expect(isRateLimitRejection({ remainingPoints: 0 })).toBe(false);
    expect(isRateLimitRejection({})).toBe(false);
  });
});

describe("retryAfterSeconds", () => {
  test("rounds UP, so a retry is never invited back inside the window", () => {
    // The floor of 1500ms is 1s, and a caller retrying after 1s is still rate-limited — which reads to them
    // as the limiter being broken.
    expect(retryAfterSeconds({ msBeforeNext: 1500 })).toBe(2);
    expect(retryAfterSeconds({ msBeforeNext: 1001 })).toBe(2);
    expect(retryAfterSeconds({ msBeforeNext: 1000 })).toBe(1);
  });

  test("a sub-second budget still asks for a whole second, never zero", () => {
    // Retry-After: 0 tells a client to retry immediately, which is the opposite of the instruction.
    expect(retryAfterSeconds({ msBeforeNext: 1 })).toBe(1);
    expect(retryAfterSeconds({ msBeforeNext: 999 })).toBe(1);
  });

  test("an exhausted-and-expired window reports 0 rather than a negative wait", () => {
    expect(retryAfterSeconds({ msBeforeNext: 0 })).toBe(0);
  });
});
