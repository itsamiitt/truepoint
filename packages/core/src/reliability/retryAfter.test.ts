// retryAfter.test.ts — both RFC 9110 Retry-After forms, deterministically (injected clock).

import { describe, expect, test } from "bun:test";
import { parseRetryAfterMs, retryAfterFromHeaders } from "./retryAfter.ts";

const NOW = Date.parse("2026-08-22T10:00:00Z");
const clock = () => NOW;

describe("parseRetryAfterMs", () => {
  test("delta-seconds form (the form every vendor uses)", () => {
    expect(parseRetryAfterMs("300", clock)).toBe(300_000);
    expect(parseRetryAfterMs("0", clock)).toBe(0);
    expect(parseRetryAfterMs(" 42 ", clock)).toBe(42_000);
  });

  test("decimal seconds round to ms", () => {
    expect(parseRetryAfterMs("1.5", clock)).toBe(1_500);
  });

  test("HTTP-date form measures from the injected clock", () => {
    expect(parseRetryAfterMs("Sat, 22 Aug 2026 10:05:00 GMT", clock)).toBe(5 * 60_000);
  });

  test("a PAST HTTP-date clamps to 0, never negative", () => {
    expect(parseRetryAfterMs("Sat, 22 Aug 2026 09:00:00 GMT", clock)).toBe(0);
  });

  test("garbage, negatives, and absence → undefined", () => {
    expect(parseRetryAfterMs("soon", clock)).toBeUndefined();
    expect(parseRetryAfterMs("-5", clock)).toBeUndefined();
    expect(parseRetryAfterMs("", clock)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, clock)).toBeUndefined();
  });
});

describe("retryAfterFromHeaders", () => {
  test("lowercased key (the transport contract)", () => {
    expect(retryAfterFromHeaders({ "retry-after": "30" }, clock)).toBe(30_000);
  });

  test("case-insensitive fallback for hand-built records", () => {
    expect(retryAfterFromHeaders({ "Retry-After": "30" }, clock)).toBe(30_000);
  });

  test("absent header / absent record → undefined", () => {
    expect(retryAfterFromHeaders({}, clock)).toBeUndefined();
    expect(retryAfterFromHeaders(undefined, clock)).toBeUndefined();
  });
});
