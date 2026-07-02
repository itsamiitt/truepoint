// outboxRelay.test.ts — proves the leaderless relay's routing + failure semantics (worker-platform plan 15
// §5.3) against a fake repository seam: publish → settle, unknown topic → terminal fail, publish error →
// row left pending (re-claimable), backlog drains through consecutive full batches, and stop() awaits the
// in-flight tick. Pure — no DB/Redis.

import { expect, test } from "bun:test";
import type { ClaimedOutboxRow } from "@leadwolf/db";
import { startOutboxRelay } from "./outboxRelay.ts";

function fakeRepo(batches: ClaimedOutboxRow[][]) {
  const published: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  let claims = 0;
  return {
    published,
    failed,
    get claims() {
      return claims;
    },
    claimPendingBatch: (_limit: number): Promise<ClaimedOutboxRow[]> => {
      claims += 1;
      return Promise.resolve(batches.shift() ?? []);
    },
    markPublished: (id: string): Promise<void> => {
      published.push(id);
      return Promise.resolve();
    },
    markFailed: (id: string, error: string): Promise<void> => {
      failed.push({ id, error });
      return Promise.resolve();
    },
  };
}

const row = (id: string, topic = "bulk_enrichment.drive"): ClaimedOutboxRow => ({
  id,
  topic,
  payload: { kind: "drive", jobId: id },
});

test("publishes claimed rows to the topic publisher and settles them", async () => {
  const repo = fakeRepo([[row("a"), row("b")]]);
  const sent: unknown[] = [];
  const relay = startOutboxRelay({
    publishers: {
      "bulk_enrichment.drive": (p) => {
        sent.push(p);
        return Promise.resolve();
      },
    },
    pollMs: 5,
    batchSize: 10,
    repository: repo,
  });
  await Bun.sleep(20);
  await relay.stop();
  expect(sent).toHaveLength(2);
  expect(repo.published).toEqual(["a", "b"]);
  expect(repo.failed).toEqual([]);
});

test("a row with no registered publisher is terminally failed (wiring bug, not a retry)", async () => {
  const repo = fakeRepo([[row("x", "unknown.topic")]]);
  const relay = startOutboxRelay({
    publishers: {},
    pollMs: 5,
    repository: repo,
  });
  await Bun.sleep(20);
  await relay.stop();
  expect(repo.published).toEqual([]);
  expect(repo.failed).toHaveLength(1);
  expect(repo.failed[0]?.error).toContain("unknown.topic");
});

test("a publish failure leaves the row pending (not settled, not terminally failed here)", async () => {
  const repo = fakeRepo([[row("p")]]);
  const relay = startOutboxRelay({
    publishers: {
      "bulk_enrichment.drive": () => Promise.reject(new Error("redis down")),
    },
    pollMs: 5,
    repository: repo,
  });
  await Bun.sleep(20);
  await relay.stop();
  // Neither settled nor failed: the claim counted the attempt; a later tick re-claims, and the repository's
  // attempts cap is what eventually fails a poison row.
  expect(repo.published).toEqual([]);
  expect(repo.failed).toEqual([]);
});

test("a full batch drains through consecutive claims without waiting a poll interval", async () => {
  // batchSize 1 → each claim returns a full batch → the drain loop re-claims immediately.
  const repo = fakeRepo([[row("1")], [row("2")], []]);
  const relay = startOutboxRelay({
    publishers: { "bulk_enrichment.drive": () => Promise.resolve() },
    pollMs: 60_000, // a poll gap long enough that only the in-tick drain loop can explain both publishes
    batchSize: 1,
    repository: repo,
  });
  await Bun.sleep(30);
  await relay.stop();
  expect(repo.published).toEqual(["1", "2"]);
});

test("stop() halts the schedule and awaits the in-flight tick", async () => {
  const repo = fakeRepo([[row("s")]]);
  let resolvePublish: (() => void) | undefined;
  const relay = startOutboxRelay({
    publishers: {
      "bulk_enrichment.drive": () =>
        new Promise<void>((resolve) => {
          resolvePublish = resolve;
        }),
    },
    pollMs: 5,
    repository: repo,
  });
  await Bun.sleep(10); // the tick is now blocked inside the publisher
  const stopping = relay.stop();
  let stopSettled = false;
  void stopping.then(() => {
    stopSettled = true;
  });
  await Bun.sleep(10);
  expect(stopSettled).toBe(false); // stop waits for the in-flight publish…
  resolvePublish?.();
  await stopping; // …and settles once it completes
  expect(repo.published).toEqual(["s"]);
  const claimsAtStop = repo.claims;
  await Bun.sleep(20);
  expect(repo.claims).toBe(claimsAtStop); // no further ticks after stop
});
