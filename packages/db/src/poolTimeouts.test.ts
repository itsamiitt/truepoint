// poolTimeouts.test.ts — the two statement-timeout knobs are INDEPENDENT (E-6.6).
//
// The Forge pool deliberately does not inherit DB_STATEMENT_TIMEOUT_MS. That independence is what let the
// Forge timeout be turned on at all: the request path wants a bound measured in seconds, while the Forge DAG
// legitimately holds a transaction across an Anthropic call. If Forge inherited the app's value, tightening
// the request path would silently start killing healthy extraction work — a regression that would look like
// flaky provider failures, not like a config change.
//
// Driven through the PURE resolver rather than by reading source or inspecting the live pool. Both knobs
// default to 0, so an accidental inheritance would pass every runtime assertion and only bite in production;
// the resolver can be called with values this process never booted with.

import { describe, expect, test } from "bun:test";
import { forgeStatementTimeoutMs } from "./client.ts";

describe("forgeStatementTimeoutMs", () => {
  test("uses the Forge knob when it is set", () => {
    expect(forgeStatementTimeoutMs(30_000, 0)).toBe(30_000);
  });

  test("IGNORES the app knob entirely — this is the whole point", () => {
    // An operator tightening the request path to 5s must not start killing Forge jobs that legitimately
    // hold a transaction across a provider call.
    expect(forgeStatementTimeoutMs(0, 5_000)).toBe(0);
  });

  test("the Forge knob wins even when both are set", () => {
    expect(forgeStatementTimeoutMs(60_000, 5_000)).toBe(60_000);
  });

  test("unset means NO timeout — today's behaviour, so the mechanism ships inert", () => {
    expect(forgeStatementTimeoutMs(0, 0)).toBe(0);
  });
});

describe("the env surface", () => {
  test("both knobs exist and default to 0", async () => {
    const { env } = await import("@leadwolf/config");
    expect(env.DB_STATEMENT_TIMEOUT_MS).toBe(0);
    expect(env.FORGE_DB_STATEMENT_TIMEOUT_MS).toBe(0);
  });
});
