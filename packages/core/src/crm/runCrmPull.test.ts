// runCrmPull.test.ts — the bulk CRM→TP readers (crm-sync 00 §3.3). Injected deps; no DB, no network.
//
// The assertions that matter are about WHEN progress is saved. A watermark advanced too eagerly is silent,
// unrecoverable data loss — records sit below a mark claiming they were applied and no later poll asks for
// them again. So every failure path here asserts that saveProgress was NOT called.

import { describe, expect, mock, test } from "bun:test";
import type { CrmConnector } from "./port.ts";
import {
  type CrmPullDeps,
  type CrmPullGates,
  runCrmBackfillPage,
  runCrmDelta,
} from "./runCrmPull.ts";

const GATES: CrmPullGates = { envEnabled: true, tenantFlagEnabled: true, syncMode: "enforce" };

type SaveProgressArgs = Parameters<CrmPullDeps["saveProgress"]>[0];

function fakeDeps(over: Partial<CrmPullDeps> = {}) {
  const counts: Record<string, number> = {};
  // Typed on its argument so `.mock.calls[0][0]` is the real shape rather than an empty tuple — the
  // assertions below inspect WHAT was saved, not just that something was.
  const saveProgress = mock(async (_args: SaveProgressArgs) => {});
  const deps: CrmPullDeps = {
    saveProgress,
    loadTokenBundle: async () => ({
      accessToken: "tok",
      expiresAt: 0,
      scopes: [],
      environment: "production" as const,
    }),
    applyRecord: async () => ({ outcome: "applied" as const }),
    addCounts: async (c) => {
      for (const [k, v] of Object.entries(c)) counts[k] = (counts[k] ?? 0) + v;
    },
    ...over,
  };
  return Object.assign(deps, { counts, saveProgress });
}

function connectorWith(
  pullPage: unknown = {
    kind: "ok",
    value: { records: [{ Id: "1" }, { Id: "2" }], highWatermark: "2026-06-10T00:00:00Z" },
    limits: {},
  },
  pullDelta: unknown = {
    kind: "ok",
    value: { records: [{ Id: "3" }], highWatermark: "2026-06-11T00:00:00Z" },
    limits: {},
  },
) {
  return {
    provider: "salesforce",
    configured: true,
    pullPage: mock(async () => pullPage),
    pullDelta: mock(async () => pullDelta),
  } as unknown as CrmConnector;
}

const base = (connector: CrmConnector, deps: CrmPullDeps) => ({
  provider: "salesforce" as const,
  objectType: "contact" as const,
  pageSize: 200,
  gates: GATES,
  connector,
  deps,
});

describe("gates", () => {
  for (const [label, gates] of [
    ["env", { ...GATES, envEnabled: false }],
    ["tenant flag", { ...GATES, tenantFlagEnabled: false }],
    ["connection", { ...GATES, syncMode: "disabled" as const }],
  ] as const) {
    test(`${label}: both runners refuse without an API call`, async () => {
      const connector = connectorWith();
      const deps = fakeDeps();
      const b = await runCrmBackfillPage({ ...base(connector, deps), gates });
      const d = await runCrmDelta({ ...base(connector, deps), gates, since: new Date() });
      expect(b.outcome).toBe("gated");
      expect(d.outcome).toBe("gated");
      expect(deps.counts.apiCalls).toBeUndefined();
    });
  }
});

describe("runCrmBackfillPage", () => {
  test("applies a page and reports 'more' with the next cursor", async () => {
    const connector = connectorWith({
      kind: "ok",
      value: { records: [{ Id: "1" }, { Id: "2" }], nextCursor: "page-2" },
      limits: {},
    });
    const deps = fakeDeps();
    const r = await runCrmBackfillPage(base(connector, deps));

    expect(r.outcome).toBe("more");
    expect(r.nextCursor).toBe("page-2");
    expect(r.applied).toBe(2);
    // The caller enqueues the follow-up; the runner does NOT loop, so a long backfill cannot monopolise a
    // worker or starve real-time jobs.
    expect(deps.saveProgress).toHaveBeenCalledTimes(1);
  });

  test("the LAST page completes and only THEN sets the watermark", async () => {
    const connector = connectorWith({
      kind: "ok",
      value: { records: [{ Id: "9" }], highWatermark: "2026-06-10T00:00:00Z" },
      limits: {},
    });
    const deps = fakeDeps();
    const r = await runCrmBackfillPage(base(connector, deps));

    expect(r.outcome).toBe("completed");
    expect(r.watermark?.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    const arg = deps.saveProgress.mock.calls[0]?.[0] as {
      backfillStatus: string;
      watermark?: Date;
    };
    expect(arg.backfillStatus).toBe("completed");
    expect(arg.watermark).toBeDefined();
  });

  test("a MID-backfill page does not set a watermark", async () => {
    // Setting it mid-backfill would let the delta sweep start from a mark the backfill has not reached,
    // and everything in between would never be read by either.
    const connector = connectorWith({
      kind: "ok",
      value: {
        records: [{ Id: "1" }],
        nextCursor: "page-2",
        highWatermark: "2026-06-10T00:00:00Z",
      },
      limits: {},
    });
    const deps = fakeDeps();
    await runCrmBackfillPage(base(connector, deps));
    const arg = deps.saveProgress.mock.calls[0]?.[0] as { watermark?: Date };
    expect(arg.watermark).toBeUndefined();
  });

  test("a partial page saves NO progress, so the page is retried whole", async () => {
    const applyRecord = mock(async (r: unknown) =>
      (r as { Id: string }).Id === "2"
        ? { outcome: "failed" as const }
        : { outcome: "applied" as const },
    );
    const deps = fakeDeps({ applyRecord });
    const r = await runCrmBackfillPage(base(connectorWith(), deps));

    expect(r.outcome).toBe("partial");
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(1);
    // Re-application is a no-op (link table + content hash), so replaying is cheap; skipping is not
    // recoverable. Hence: no progress saved.
    expect(deps.saveProgress).not.toHaveBeenCalled();
  });

  test("one throwing record does not abort the rest of the page", async () => {
    // A single malformed CRM row must not be able to wedge a connection permanently, retry after retry.
    const applyRecord = mock(async (r: unknown) => {
      if ((r as { Id: string }).Id === "1") throw new Error("boom");
      return { outcome: "applied" as const };
    });
    const deps = fakeDeps({ applyRecord });
    const r = await runCrmBackfillPage(base(connectorWith(), deps));
    expect(r.failed).toBe(1);
    expect(r.applied).toBe(1);
    expect(applyRecord).toHaveBeenCalledTimes(2);
  });

  test("rate limiting stops cleanly and saves nothing", async () => {
    const connector = connectorWith({ kind: "rate_limited", retryAfterMs: 60_000, daily: true });
    const deps = fakeDeps();
    const r = await runCrmBackfillPage(base(connector, deps));

    expect(r.outcome).toBe("rate_limited");
    expect(r.retryAfterMs).toBe(60_000);
    expect(r.reason).toBe("daily_cap");
    expect(deps.saveProgress).not.toHaveBeenCalled();
    expect(deps.counts.recordsFailed).toBeUndefined(); // a throttle is not a failure
  });

  test("a transport error is a failure that saves nothing", async () => {
    const connector = connectorWith({ kind: "transient", status: 503 });
    const deps = fakeDeps();
    const r = await runCrmBackfillPage(base(connector, deps));
    expect(r.outcome).toBe("failed");
    expect(deps.saveProgress).not.toHaveBeenCalled();
  });
});

describe("runCrmDelta", () => {
  test("applies the page and advances to the PROVIDER's high-watermark", async () => {
    const deps = fakeDeps();
    const r = await runCrmDelta({
      ...base(connectorWith(), deps),
      since: new Date(Date.parse("2026-06-09T00:00:00Z")),
    });

    expect(r.outcome).toBe("completed");
    // The provider's value, not our clock: our clock running fast would skip every record the CRM wrote
    // in the gap, permanently.
    expect(r.watermark?.toISOString()).toBe("2026-06-11T00:00:00.000Z");
  });

  test("passes `since` through to the connector verbatim", async () => {
    const connector = connectorWith();
    const deps = fakeDeps();
    const since = new Date(Date.parse("2026-06-09T00:00:00Z"));
    await runCrmDelta({ ...base(connector, deps), since });
    const arg = (
      connector.pullDelta as unknown as { mock: { calls: Array<[{ sinceWatermark: string }]> } }
    ).mock.calls[0]?.[0];
    // The caller already subtracted the overlap window (readWithOverlap); the runner must not second-guess it.
    expect(arg?.sinceWatermark).toBe("2026-06-09T00:00:00.000Z");
  });

  test("NO watermark is refused, not defaulted to the epoch", async () => {
    // "Pull everything since 1970" against a rate-limited API is an accidental full scan, and it is what a
    // missing backfill actually looks like.
    const deps = fakeDeps();
    const r = await runCrmDelta({ ...base(connectorWith(), deps), since: null });
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("no_watermark_run_backfill_first");
    expect(deps.counts.apiCalls).toBeUndefined();
  });

  test("an EMPTY page still advances the watermark", async () => {
    // A quiet stream must not keep re-asking for the same window forever.
    const connector = connectorWith(undefined, {
      kind: "ok",
      value: { records: [], highWatermark: "2026-07-01T00:00:00Z" },
      limits: {},
    });
    const deps = fakeDeps();
    const r = await runCrmDelta({ ...base(connector, deps), since: new Date() });
    expect(r.applied).toBe(0);
    expect(r.watermark?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(deps.saveProgress).toHaveBeenCalledTimes(1);
  });

  test("a partial page does NOT advance the watermark", async () => {
    const connector = connectorWith(undefined, {
      kind: "ok",
      value: { records: [{ Id: "a" }, { Id: "b" }], highWatermark: "2026-07-01T00:00:00Z" },
      limits: {},
    });
    const applyRecord = mock(async (r: unknown) =>
      (r as { Id: string }).Id === "b"
        ? { outcome: "failed" as const }
        : { outcome: "applied" as const },
    );
    const deps = fakeDeps({ applyRecord });
    const r = await runCrmDelta({ ...base(connector, deps), since: new Date() });

    expect(r.outcome).toBe("partial");
    // This is THE assertion of this file: advancing here would strand record "b" below a mark that claims
    // it was applied, and nothing would ever ask for it again.
    expect(deps.saveProgress).not.toHaveBeenCalled();
  });

  test("a missing high-watermark leaves the mark alone rather than guessing", async () => {
    const connector = connectorWith(undefined, {
      kind: "ok",
      value: { records: [{ Id: "a" }], highWatermark: "" },
      limits: {},
    });
    const deps = fakeDeps();
    const r = await runCrmDelta({ ...base(connector, deps), since: new Date() });
    expect(r.outcome).toBe("completed");
    expect(r.reason).toBe("no_high_watermark");
    // The overlap window means the next poll re-reads the same window rather than skipping it.
    expect(deps.saveProgress).not.toHaveBeenCalled();
  });

  test("an unparseable high-watermark is treated as missing, not as NaN", async () => {
    const connector = connectorWith(undefined, {
      kind: "ok",
      value: { records: [], highWatermark: "not-a-date" },
      limits: {},
    });
    const deps = fakeDeps();
    const r = await runCrmDelta({ ...base(connector, deps), since: new Date() });
    // An Invalid Date written to a timestamptz column would either throw at bind or poison the watermark.
    expect(r.reason).toBe("no_high_watermark");
    expect(deps.saveProgress).not.toHaveBeenCalled();
  });

  test("rate limiting stops cleanly and saves nothing", async () => {
    const connector = connectorWith(undefined, {
      kind: "rate_limited",
      retryAfterMs: 5_000,
      daily: false,
    });
    const deps = fakeDeps();
    const r = await runCrmDelta({ ...base(connector, deps), since: new Date() });
    expect(r.outcome).toBe("rate_limited");
    expect(deps.saveProgress).not.toHaveBeenCalled();
  });
});
