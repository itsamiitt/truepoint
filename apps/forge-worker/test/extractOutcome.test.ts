// extractOutcome.test.ts — how the extract stage routes each extraction OUTCOME. The interesting one is
// `budget_exceeded`, which used to fall into the terminal branch and be QUARANTINED.
//
// That was wrong twice over. Quarantine means "retrying cannot change the result", and this result changes by
// itself when the budget window rolls. And because the AI budget store fails CLOSED, a Redis outage produces
// this outcome for EVERY capture — so a blip would have permanently quarantined the whole in-flight pipeline,
// with a human needed to dig each capture back out.
//
// It was also effectively unreachable until the budget was made enforceable (the old per-capture key meant it
// never exhausted), so fixing the budget is what turned a latent mishandling into a live one. These tests pin
// the three classes apart so that cannot silently regress.
//
// The outcomes are produced by driving the REAL runExtraction through the injected port and budget store,
// never by stubbing @leadwolf/forge-core: mock.module is process-global, so replacing that barrel would also
// replace runExtraction for its own test file. Going through the real stage is also the stronger test — it
// pins the handler against the outcomes the stage actually emits rather than the ones this file imagines.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDb from "@leadwolf/db";
import type { ExtractionOutcome, ExtractionOutcomeCode } from "@leadwolf/forge-core";

const quarantined: Array<{ rawCaptureId: string; route: string; reason: string }> = [];

// The db barrel IS stubbed — the handler imports withForgeTx/getRawCaptureById directly, so there is no seam
// to inject through. Spread the real module: a partial stub REPLACES it for every other file in the run.
mock.module("@leadwolf/db", () => ({
  ...realDb,
  withForgeTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  getRawCaptureById: async () => ({
    id: "cap-1",
    targetTenantId: "tenant-1",
    payloadInline: "{}",
    payloadRef: null,
    schemaVersion: "1-0-0",
  }),
  countExtractionCandidates: async () => 0,
  insertExtractionRun: async () => {},
  insertExtractionCandidates: async () => {},
  insertQuarantine: async (
    _tx: unknown,
    row: { rawCaptureId: string; route: string; reason: string },
  ) => {
    quarantined.push(row);
  },
}));

const { makeExtractProcessor } = await import("../src/processors.ts");

/** Records what the handler enqueues, so a park is observable. */
function harness(outcome: ExtractionOutcomeCode, budgetExhausted = false) {
  const added: Array<{ data: unknown; opts: unknown }> = [];
  const queue = {
    add: async (_name: string, data: unknown, opts?: unknown) => {
      added.push({ data, opts });
    },
  };
  const extractPort = {
    extract: async (): Promise<ExtractionOutcome> => ({
      outcome,
      fields: [],
      usedRepair: false,
      model: "test-model",
    }),
  };
  // reserve() returns the POST-increment total; the stage compares it against its limit. A number far above
  // the limit is exactly what an exhausted tenant — or a fail-closed store during a Redis outage — reports.
  const budgetStore = {
    reserve: async () => (budgetExhausted ? 1_000_000 : 1),
    release: async () => {},
  };
  // biome-ignore lint/suspicious/noExplicitAny: a minimal ProcessorDeps, not the full adapter surface.
  const deps: any = {
    blob: { fetch: async () => "{}" },
    registry: {},
    extractPort,
    queues: { aiExtract: queue, resolve: queue, verify: queue },
    leader: async (fn: () => Promise<unknown>) => fn(),
    budgetStore,
  };
  return { deps, added };
}

const run = async (
  outcome: ExtractionOutcomeCode,
  opts: { parks?: number; budgetExhausted?: boolean } = {},
) => {
  const { deps, added } = harness(outcome, opts.budgetExhausted);
  const handler = makeExtractProcessor(deps);
  // biome-ignore lint/suspicious/noExplicitAny: a Job stub with only the fields the handler reads.
  await handler({ data: { rawCaptureId: "cap-1", parks: opts.parks } } as any);
  return added;
};

const runParked = (parks?: number) => run("ok", { parks, budgetExhausted: true });

beforeEach(() => {
  quarantined.length = 0;
});

describe("budget_exceeded is PARKED, never quarantined", () => {
  test("re-enqueues itself with a delay instead of quarantining", async () => {
    const added = await runParked();

    expect(quarantined).toEqual([]); // the regression this file exists for
    expect(added).toHaveLength(1);
    expect(added[0]?.data).toMatchObject({ rawCaptureId: "cap-1", parks: 1 });
    // A delay is the whole point: throwing would burn the queue's attempt limit within minutes against a
    // budget measured in hours, and DLQ a capture that was never broken.
    expect((added[0]?.opts as { delay?: number })?.delay).toBeGreaterThan(0);
  });

  test("the park counter increments so the retry is bounded", async () => {
    const added = await runParked(3);
    expect(added[0]?.data).toMatchObject({ parks: 4 });
  });

  test("past the park limit it THROWS, so a permanently exhausted budget reaches the DLQ", async () => {
    // Bounded on purpose: a silent park loop would hide an exhausted budget forever. The DLQ is visible and
    // alertable; quarantine and an infinite loop are neither.
    await expect(runParked(99)).rejects.toThrow(/budget still exhausted/);
    expect(quarantined).toEqual([]);
  });
});

describe("the other outcome classes are unchanged", () => {
  test("ai_unavailable THROWS — the queue owns that retry", async () => {
    await expect(run("ai_unavailable")).rejects.toThrow(/provider unavailable/);
    expect(quarantined).toEqual([]);
  });

  test("a terminal outcome quarantines and does NOT advance the DAG", async () => {
    // refused/truncated/ai_invalid_output cannot succeed on retry against the same residue.
    for (const outcome of ["refused", "truncated", "ai_invalid_output"] as const) {
      quarantined.length = 0;
      const added = await run(outcome);
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]).toMatchObject({
        rawCaptureId: "cap-1",
        route: "ai-extract",
        reason: outcome,
      });
      expect(added).toEqual([]);
    }
  });

  test("a clean extraction advances to resolve", async () => {
    const added = await run("ok");
    expect(quarantined).toEqual([]);
    expect(added).toHaveLength(1);
    expect(added[0]?.data).toEqual({ rawCaptureId: "cap-1" });
  });
});
