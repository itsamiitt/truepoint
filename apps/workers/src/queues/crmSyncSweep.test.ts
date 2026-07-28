// crmSyncSweep.test.ts — the leader-locked CRM-sync scheduler (crm-sync 00 §3.2/§3.3).
//
// The whole processor is exercised, not just a pure helper: the worklist reads, the enqueuers and the L1
// gate are all injected, and Redis is a small fake. Nothing is mock.module'd — under `bun test` that is
// process-global and would replace @leadwolf/db for every other file in the run.
//
// The gate is passed in rather than read from env inside the processor precisely so BOTH directions run
// here. A processor that read env directly could only ever be tested in whichever state the test process
// booted with, and in CI that means the interesting half never runs.

import { describe, expect, mock, test } from "bun:test";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import {
  type CrmConnectionRef,
  type CrmSyncSweepJobData,
  makeProcessCrmSyncSweep,
} from "./crmSyncSweep.ts";

/** A Redis stand-in for withLeaderLock: `set(...NX)` returns "OK" (won) or null (lost). */
function fakeRedis(won = true) {
  return {
    set: mock(async () => (won ? "OK" : null)),
    eval: mock(async () => 1),
  } as unknown as IORedis & { set: ReturnType<typeof mock> };
}

const conns = (n: number): CrmConnectionRef[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `conn-${i}`,
    tenantId: "t1",
    workspaceId: "w1",
    provider: "salesforce",
  }));

const job = (kind: "delta" | "reconcile" | "refresh" = "delta") =>
  ({ data: { kind } }) as unknown as Job<CrmSyncSweepJobData>;

describe("L1 — the global kill switch", () => {
  test("OFF: the sweep does not even contend for the leader lock", async () => {
    const redis = fakeRedis();
    const listDueForPoll = mock(async () => conns(3));
    const enqueuePull = mock(async () => ({}));

    await makeProcessCrmSyncSweep(redis, {
      enabled: false,
      enqueuePull,
      enqueueRefresh: async () => ({}),
      listDueForPoll,
    })(job());

    // A dark engine should cost NOTHING — not a Redis round-trip every 60s across every worker in the fleet.
    expect(redis.set).not.toHaveBeenCalled();
    expect(listDueForPoll).not.toHaveBeenCalled();
    expect(enqueuePull).not.toHaveBeenCalled();
  });

  test("ON: the lock is taken and the worklist is read", async () => {
    const redis = fakeRedis();
    const listDueForPoll = mock(async () => conns(1));
    await makeProcessCrmSyncSweep(redis, {
      enabled: true,
      enqueuePull: async () => ({}),
      enqueueRefresh: async () => ({}),
      listDueForPoll,
    })(job());
    expect(redis.set).toHaveBeenCalled();
    expect(listDueForPoll).toHaveBeenCalled();
  });
});

describe("leader election", () => {
  test("a LOST election does no work at all", async () => {
    const listDueForPoll = mock(async () => conns(3));
    const enqueuePull = mock(async () => ({}));
    await makeProcessCrmSyncSweep(fakeRedis(false), {
      enabled: true,
      enqueuePull,
      enqueueRefresh: async () => ({}),
      listDueForPoll,
    })(job());
    // Exactly one worker fans out per tick; the losers must not duplicate the enumeration or the enqueues.
    expect(listDueForPoll).not.toHaveBeenCalled();
    expect(enqueuePull).not.toHaveBeenCalled();
  });

  test("the lock is RELEASED even when the body throws", async () => {
    const redis = fakeRedis();
    const listDueForPoll = mock(async () => {
      throw new Error("db down");
    });
    await expect(
      makeProcessCrmSyncSweep(redis, {
        enabled: true,
        enqueuePull: async () => ({}),
        enqueueRefresh: async () => ({}),
        listDueForPoll,
      })(job()),
    ).rejects.toThrow();
    // withLeaderLock releases in a finally — without it a crashed tick would block every later tick until
    // the TTL expired.
    expect((redis as unknown as { eval: ReturnType<typeof mock> }).eval).toHaveBeenCalled();
  });
});

describe("the reconcile backstop", () => {
  test("reconcile enumerates ALL connected connections, not just those due", async () => {
    // The backstop exists to re-read streams the delta tick believes are up to date, so filtering by
    // next_poll_at would skip exactly the connections it is meant to check.
    const listDueForPoll = mock(async () => conns(1));
    const listAllConnected = mock(async () => conns(4));
    const enqueuePull = mock(async () => ({}));

    await makeProcessCrmSyncSweep(fakeRedis(), {
      enabled: true,
      enqueuePull,
      enqueueRefresh: async () => ({}),
      listDueForPoll,
      listAllConnected,
    })(job("reconcile"));

    expect(listAllConnected).toHaveBeenCalled();
    expect(listDueForPoll).not.toHaveBeenCalled();
    expect(enqueuePull).toHaveBeenCalledTimes(4);
  });

  test("reconcile passes the flag through; a delta does not", async () => {
    const enqueuePull = mock(async (_c: CrmConnectionRef, _r?: boolean) => ({}));
    const deps = {
      enabled: true,
      enqueuePull,
      enqueueRefresh: async () => ({}),
      listDueForPoll: async () => conns(1),
      listAllConnected: async () => conns(1),
    };

    await makeProcessCrmSyncSweep(fakeRedis(), deps)(job("reconcile"));
    expect(enqueuePull.mock.calls[0]?.[1]).toBe(true);

    await makeProcessCrmSyncSweep(fakeRedis(), deps)(job("delta"));
    expect(enqueuePull.mock.calls[1]?.[1]).toBe(false);
  });
});

describe("fan-out", () => {
  test("enqueues one pull per due connection", async () => {
    const enqueuePull = mock(async () => ({}));
    await makeProcessCrmSyncSweep(fakeRedis(), {
      enabled: true,
      enqueuePull,
      enqueueRefresh: async () => ({}),
      listDueForPoll: async () => conns(3),
    })(job());
    expect(enqueuePull).toHaveBeenCalledTimes(3);
  });

  test("the refresh tick uses the refresh worklist, not the poll one", async () => {
    const enqueueRefresh = mock(async () => ({}));
    const enqueuePull = mock(async () => ({}));
    const listDueForPoll = mock(async () => conns(5));
    await makeProcessCrmSyncSweep(fakeRedis(), {
      enabled: true,
      enqueuePull,
      enqueueRefresh,
      listDueForPoll,
      listDueForRefresh: async () => conns(2),
    })(job("refresh"));

    expect(enqueueRefresh).toHaveBeenCalledTimes(2);
    expect(enqueuePull).not.toHaveBeenCalled();
    expect(listDueForPoll).not.toHaveBeenCalled();
  });

  test("a job with no explicit kind defaults to the delta tick", async () => {
    const enqueuePull = mock(async () => ({}));
    await makeProcessCrmSyncSweep(fakeRedis(), {
      enabled: true,
      enqueuePull,
      enqueueRefresh: async () => ({}),
      listDueForPoll: async () => conns(1),
    })({ data: undefined } as unknown as Job<CrmSyncSweepJobData>);
    expect(enqueuePull).toHaveBeenCalledTimes(1);
  });

  test("one failing enqueue does not abort the tick", async () => {
    let calls = 0;
    const enqueuePull = mock(async () => {
      calls += 1;
      if (calls === 2) throw new Error("redis blip");
      return {};
    });
    await makeProcessCrmSyncSweep(fakeRedis(), {
      enabled: true,
      enqueuePull,
      enqueueRefresh: async () => ({}),
      listDueForPoll: async () => conns(4),
    })(job());
    // All four attempted: one bad connection must not stop the fleet's sweep for everyone else.
    expect(enqueuePull).toHaveBeenCalledTimes(4);
  });

  test("an empty worklist enqueues nothing and does not throw", async () => {
    const enqueuePull = mock(async () => ({}));
    await makeProcessCrmSyncSweep(fakeRedis(), {
      enabled: true,
      enqueuePull,
      enqueueRefresh: async () => ({}),
      listDueForPoll: async () => [],
    })(job());
    expect(enqueuePull).not.toHaveBeenCalled();
  });
});
