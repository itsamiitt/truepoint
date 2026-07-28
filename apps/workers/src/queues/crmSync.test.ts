// crmSync.test.ts — the CRM consumers' PURE routing decision (crm-sync 00 §3.2 / §4.6).
//
// The processors themselves are thin IO delegates over withTenantTx + the repositories, so what is
// unit-testable here is the piece that carries a real decision: how a runner's outcome maps onto the run
// ledger's closed status enum. That mapping is what a health surface reads, and getting it wrong is how a
// dark tenant ends up looking like a broken one.
//
// The IO paths are exercised by the DB itests; the runners themselves have their own suites.

import { describe, expect, test } from "bun:test";
import { runStatusForOutcome } from "./crmSync.ts";

describe("runStatusForOutcome", () => {
  test("a GATED job is cancelled, NOT failed", () => {
    // Nothing went wrong — the engine is simply off for this tenant. A health surface that showed these as
    // failures would cry wolf on every dark tenant, which is every tenant until an operator opts one in.
    expect(runStatusForOutcome("gated")).toBe("cancelled");
  });

  test("a real failure is failed", () => {
    expect(runStatusForOutcome("failed")).toBe("failed");
  });

  test("a partial page is partial", () => {
    expect(runStatusForOutcome("partial")).toBe("partial");
  });

  test("rate limiting is PARTIAL, not failed", () => {
    // The provider asked us to come back. The work is incomplete, but the connection is healthy — and the
    // caller re-enqueues rather than burning a retry.
    expect(runStatusForOutcome("rate_limited")).toBe("partial");
  });

  for (const ok of ["pushed", "applied", "created", "shadowed", "skipped", "completed", "more"]) {
    test(`${ok} closes the run as completed`, () => {
      expect(runStatusForOutcome(ok)).toBe("completed");
    });
  }

  test("the refusal outcomes that are not errors also close as completed", () => {
    // `suppressed` and `echo` are the engine working correctly: an erased subject was not re-created, and
    // our own write was not applied twice. Neither is a failure.
    expect(runStatusForOutcome("suppressed")).toBe("completed");
    expect(runStatusForOutcome("echo")).toBe("completed");
    expect(runStatusForOutcome("not_found")).toBe("completed");
    expect(runStatusForOutcome("missing")).toBe("completed");
  });

  test("an unrecognised outcome does not become 'failed' by accident", () => {
    // Defaulting an unknown string to `failed` would turn any future outcome name into a fleet-wide red
    // health surface on the day it ships. Completed is the safe default; a real failure says so explicitly.
    expect(runStatusForOutcome("some_future_outcome")).toBe("completed");
  });
});
