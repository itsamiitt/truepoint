// retryPolicies.test.ts — proves every event-queue retry policy actually retries (attempts > 1), backs off
// exponentially, and carries jitter (worker-platform plan 15 §2.4: "unit-assert each of the six .add() calls
// now passes attempts>1 + a backoff strategy with jitter"). Pure — no env/Redis. Violations are collected
// into arrays asserted empty, so a failure names the offending queue(s).

import { expect, test } from "bun:test";
import { ALL_RETRY_POLICIES, OUTREACH_RETRY, type RetryPolicy } from "./retryPolicies.ts";

/** The backoff object of a policy, or null when it is missing/not an object (a violation). */
function backoffOf(policy: RetryPolicy): { type?: string; delay?: number; jitter?: number } | null {
  return typeof policy.backoff === "object" && policy.backoff !== null ? policy.backoff : null;
}

test("every policy retries: attempts > 1", () => {
  const noRetry = Object.entries(ALL_RETRY_POLICIES)
    .filter(([, policy]) => (policy.attempts ?? 0) <= 1)
    .map(([queue]) => queue);
  expect(noRetry).toEqual([]);
});

test("every policy backs off exponentially with a positive base delay", () => {
  const badBackoff = Object.entries(ALL_RETRY_POLICIES)
    .filter(([, policy]) => {
      const backoff = backoffOf(policy);
      return backoff?.type !== "exponential" || (backoff.delay ?? 0) <= 0;
    })
    .map(([queue]) => queue);
  expect(badBackoff).toEqual([]);
});

test("every policy carries jitter in (0, 1] so retries de-correlate under a shared outage", () => {
  const badJitter = Object.entries(ALL_RETRY_POLICIES)
    .filter(([, policy]) => {
      const jitter = backoffOf(policy)?.jitter ?? 0;
      return jitter <= 0 || jitter > 1;
    })
    .map(([queue]) => queue);
  expect(badJitter).toEqual([]);
});

test("outreach is capped at attempts=2 — the double-send bound (raise only with send idempotency)", () => {
  // Regression tripwire: sendStep re-sends the same step on a post-send/pre-commit retry, so a bigger budget
  // multiplies worst-case duplicate emails. See retryPolicies.ts OUTREACH_RETRY for the full rationale.
  expect(OUTREACH_RETRY.attempts).toBe(2);
});
