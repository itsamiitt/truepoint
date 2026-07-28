// poolTimeouts.test.ts — the two statement-timeout knobs are INDEPENDENT (E-6.6).
//
// The Forge pool deliberately does not inherit DB_STATEMENT_TIMEOUT_MS. That independence is the whole
// reason the Forge timeout could finally be turned on at all: the request path wants a bound measured in
// seconds, while the Forge DAG legitimately holds a transaction across an Anthropic call. If Forge inherited
// the app's value, tightening the request path would silently start killing healthy extraction work — a
// regression that would look like flaky provider failures, not like a config change.
//
// Asserted at the env-schema level rather than by inspecting the live pool: the pools are module singletons
// built at import, so a test that mutated the env afterwards would prove nothing.

import { describe, expect, test } from "bun:test";

describe("statement-timeout knobs", () => {
  test("the two knobs are separate env vars", async () => {
    const { env } = await import("@leadwolf/config");
    expect(env).toHaveProperty("DB_STATEMENT_TIMEOUT_MS");
    expect(env).toHaveProperty("FORGE_DB_STATEMENT_TIMEOUT_MS");
  });

  test("both default to 0 — the mechanism ships INERT", async () => {
    // Every timeout in this repo ships off: a bound that is wrong is worse than none, and choosing the value
    // needs a real deployment's latency profile.
    const { env } = await import("@leadwolf/config");
    expect(env.DB_STATEMENT_TIMEOUT_MS).toBe(0);
    expect(env.FORGE_DB_STATEMENT_TIMEOUT_MS).toBe(0);
  });

  test("the Forge pool reads its OWN knob, not the app's", async () => {
    // Pinned as source, because the failure this prevents is a silent one: an inherited value would work in
    // every test (both default to 0) and only bite when an operator set the app timeout in production.
    const src = await Bun.file(
      new URL("./client.ts", import.meta.url).pathname.replace(/^\//, ""),
    ).text();
    const forgeBlock = src.slice(src.indexOf("forgePoolOptions"));
    expect(forgeBlock).toContain("FORGE_DB_STATEMENT_TIMEOUT_MS");
    // The app knob must NOT appear in the forge timeout guard.
    const guard = forgeBlock.slice(0, forgeBlock.indexOf("forgeConnectionUrl"));
    expect(guard).not.toContain("env.DB_STATEMENT_TIMEOUT_MS");
  });
});
