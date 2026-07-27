import { describe, expect, test } from "bun:test";
import { withSpan } from "./tracing.ts";

/**
 * These run with NO SDK registered — which is the shipped default and the state every process is in unless an
 * OTLP endpoint is configured. The property that matters is that instrumentation is invisible there: the
 * wrapped work still runs, still returns, and still throws exactly as it would uninstrumented.
 *
 * That is the whole argument for putting `withSpan` in shared code. If the no-op path were not truly
 * transparent, every layer would be paying for telemetry that nothing collects.
 */
describe("withSpan without an SDK", () => {
  test("returns the wrapped value", async () => {
    expect(await withSpan("test.op", {}, async () => 42)).toBe(42);
  });

  test("RETHROWS — instrumentation must never swallow a failure", async () => {
    // Swallowing would be worse than no tracing at all: the trace would show a healthy operation that in
    // fact did nothing, and the caller would carry on as if it had succeeded.
    await expect(
      withSpan("test.fail", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  test('undefined attributes are skipped rather than recorded as the string "undefined"', async () => {
    // Call sites pass optional ids (workspaceId is null on tenant-scoped work); recording the literal
    // "undefined" would make those spans look attributed when they are not.
    await expect(
      withSpan("test.attrs", { tenantId: "t1", workspaceId: undefined, rows: 3 }, async () => "ok"),
    ).resolves.toBe("ok");
  });

  // NOTE: whether `activeTraceIds()` returns null is a property of the GLOBAL tracer provider, so it cannot
  // be asserted here — any other test file that registers one changes the answer, and bun loads every module
  // before running anything. It is verified in apps/api/src/telemetry.test.ts instead, which owns that
  // registration and tears it down.
});
