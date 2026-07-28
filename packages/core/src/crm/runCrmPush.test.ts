// runCrmPush.test.ts — the outbound push runner (crm-sync 00 §3.3 / §6.2). Every dependency is injected, so
// this exercises the real runner with no database and no network.
//
// What matters here is not that the happy path works — it is that the refusals refuse, in the right order,
// and that the ones which must not reach the CRM demonstrably do not. Each gate asserts BOTH the returned
// outcome and that `connector.upsert` was never called; an outcome string alone would still pass if the
// code sent the data and then reported "gated".

import { describe, expect, mock, test } from "bun:test";
import type { CrmFieldMapping, FieldProvenanceMap } from "@leadwolf/types";
import type { CrmConnector } from "./port.ts";
import { type CrmPushDeps, type CrmPushGates, runCrmPush } from "./runCrmPush.ts";

const MAPPINGS: CrmFieldMapping[] = [
  {
    objectType: "contact",
    tpField: "jobTitle",
    crmField: "Title",
    direction: "outbound",
    authority: "truepoint",
    transform: "passthrough",
    enabled: true,
  },
];

const PROVENANCE: FieldProvenanceMap = {
  jobTitle: { src: "provider:apollo", pin: false, conf: 0.9 },
};

/** A connector whose upsert records its calls and reports whatever outcome the test wants. */
function fakeConnector(
  outcome: Awaited<ReturnType<CrmConnector["upsert"]>> = {
    kind: "ok",
    value: { perRecord: [{ externalId: "tp-uuid", outcome: "created" }] },
    limits: {},
  },
) {
  const upsert = mock(async () => outcome);
  return { provider: "salesforce", configured: true, upsert } as unknown as CrmConnector & {
    upsert: ReturnType<typeof mock>;
  };
}

function fakeDeps(over: Partial<CrmPushDeps> = {}) {
  const counts: Record<string, number> = {};
  const deps: CrmPushDeps & { counts: Record<string, number> } = {
    counts,
    loadEntity: async () => ({ values: { jobTitle: "VP Sales" }, provenance: PROVENANCE }),
    isSuppressed: async () => false,
    loadLink: async () => null,
    loadMappings: async () => MAPPINGS,
    loadTokenBundle: async () => ({
      accessToken: "tok",
      expiresAt: 0,
      scopes: [],
      environment: "production" as const,
    }),
    recordPushed: async () => {},
    addCounts: async (c) => {
      for (const [k, v] of Object.entries(c)) counts[k] = (counts[k] ?? 0) + v;
    },
    ...over,
  };
  return deps;
}

const GATES_OPEN: CrmPushGates = {
  envEnabled: true,
  tenantFlagEnabled: true,
  syncMode: "enforce",
};

function run(gates: Partial<CrmPushGates>, deps: CrmPushDeps, connector: CrmConnector) {
  return runCrmPush({
    provider: "salesforce",
    objectType: "contact",
    tpEntityId: "tp-uuid",
    externalIdField: "TruePoint_Id__c",
    gates: { ...GATES_OPEN, ...gates },
    connector,
    deps,
  });
}

describe("the gate ladder refuses before any CRM call", () => {
  test("L1: the env kill switch stops everything", async () => {
    const connector = fakeConnector();
    const r = await run({ envEnabled: false }, fakeDeps(), connector);
    expect(r.outcome).toBe("gated");
    expect(r.reason).toBe("env_disabled");
    expect(connector.upsert).not.toHaveBeenCalled();
  });

  test("L2: a tenant with the flag off is refused", async () => {
    const connector = fakeConnector();
    const r = await run({ tenantFlagEnabled: false }, fakeDeps(), connector);
    expect(r.outcome).toBe("gated");
    expect(r.reason).toBe("tenant_flag_off");
    expect(connector.upsert).not.toHaveBeenCalled();
  });

  test("L3: a disabled connection is refused", async () => {
    const connector = fakeConnector();
    const r = await run({ syncMode: "disabled" }, fakeDeps(), connector);
    expect(r.outcome).toBe("gated");
    expect(r.reason).toBe("connection_disabled");
    expect(connector.upsert).not.toHaveBeenCalled();
  });

  test("the ladder short-circuits at L1 — a disabled env is not overridden by anything downstream", async () => {
    const connector = fakeConnector();
    const deps = fakeDeps({
      isSuppressed: async () => {
        throw new Error("must not be consulted once the env gate has refused");
      },
    });
    const r = await run({ envEnabled: false, syncMode: "enforce" }, deps, connector);
    expect(r.outcome).toBe("gated");
  });
});

describe("suppression", () => {
  test("a suppressed subject is refused BEFORE its values are ever loaded", async () => {
    const connector = fakeConnector();
    const loadEntity = mock(async () => ({ values: {}, provenance: {} }));
    const deps = fakeDeps({ isSuppressed: async () => true, loadEntity });

    const r = await run({}, deps, connector);
    expect(r.outcome).toBe("suppressed");
    expect(connector.upsert).not.toHaveBeenCalled();
    // The ordering IS the assertion: an erased subject's field values must not be read into memory at all.
    expect(loadEntity).not.toHaveBeenCalled();
  });
});

describe("shadow mode", () => {
  test("plans and reports, but performs NO CRM write", async () => {
    const connector = fakeConnector();
    const deps = fakeDeps();
    const r = await run({ syncMode: "shadow" }, deps, connector);

    expect(r.outcome).toBe("shadowed");
    expect(connector.upsert).not.toHaveBeenCalled();
    // Shadow is not a no-op: it reports what enforce WOULD have sent, which is the whole value of a dark
    // launch. An operator reads this off crm_sync_runs before flipping the connection.
    expect(r.operation).toBe("create");
    expect(r.fields).toContain("jobTitle");
    expect(r.contentHash).toBeTruthy();
  });

  test("does not record a push, so the link hash stays unset and enforce still has work to do", async () => {
    const recordPushed = mock(async () => {});
    const deps = fakeDeps({ recordPushed });
    await run({ syncMode: "shadow" }, deps, fakeConnector());
    expect(recordPushed).not.toHaveBeenCalled();
  });
});

describe("the content-hash short-circuit (loop guard §6.4)", () => {
  test("an unchanged record is skipped without a CRM call", async () => {
    // Compute the hash the planner would produce, then hand it back as the link's last_synced_hash.
    const connector = fakeConnector();
    const firstPass = await run({ syncMode: "shadow" }, fakeDeps(), connector);
    const hash = firstPass.contentHash as string;

    const deps = fakeDeps({
      loadLink: async () => ({ id: "link-1", crmRecordId: "SFDC-1", lastSyncedHash: hash }),
    });
    const r = await run({}, deps, connector);

    // This is what stops a two-way sync ping-ponging: our own write, echoed back by the CRM and re-queued,
    // hashes identically and dies here instead of provoking another push.
    expect(r.outcome).toBe("skipped");
    expect(r.contentHash).toBe(hash);
    expect(connector.upsert).not.toHaveBeenCalled();
  });
});

describe("enforce mode", () => {
  test("pushes, records the link, and counts a creation", async () => {
    const connector = fakeConnector();
    const recordPushed = mock(async () => {});
    const deps = fakeDeps({ recordPushed });

    const r = await run({}, deps, connector);
    expect(r.outcome).toBe("pushed");
    expect(connector.upsert).toHaveBeenCalledTimes(1);
    expect(recordPushed).toHaveBeenCalledTimes(1);
    expect((deps as unknown as { counts: Record<string, number> }).counts.recordsCreated).toBe(1);
    expect((deps as unknown as { counts: Record<string, number> }).counts.apiCalls).toBe(1);
  });

  test("the TP uuid is sent as the external key, which is what makes a retry idempotent", async () => {
    const connector = fakeConnector();
    await run({}, fakeDeps(), connector);
    const call = connector.upsert.mock.calls[0]?.[0] as {
      records: Array<{ externalId: string; values: Record<string, unknown> }>;
      externalIdField: string;
    };
    expect(call.externalIdField).toBe("TruePoint_Id__c");
    expect(call.records[0]?.externalId).toBe("tp-uuid");
    expect(call.records[0]?.values.Title).toBe("VP Sales");
  });

  test("an 'updated' result counts as an update, not a creation", async () => {
    const connector = fakeConnector({
      kind: "ok",
      value: { perRecord: [{ externalId: "tp-uuid", outcome: "updated" }] },
      limits: {},
    });
    const deps = fakeDeps();
    await run({}, deps, connector);
    const counts = (deps as unknown as { counts: Record<string, number> }).counts;
    expect(counts.recordsUpdated).toBe(1);
    expect(counts.recordsCreated).toBeUndefined();
  });
});

describe("failure handling", () => {
  test("rate_limited is NOT a failure — it does not touch recordsFailed", async () => {
    const connector = fakeConnector({ kind: "rate_limited", retryAfterMs: 30_000, daily: false });
    const deps = fakeDeps();
    const r = await run({}, deps, connector);

    expect(r.outcome).toBe("rate_limited");
    expect(r.retryAfterMs).toBe(30_000);
    const counts = (deps as unknown as { counts: Record<string, number> }).counts;
    // Counting a throttle as a failure would make a healthy-but-throttled connection look broken on the
    // health surface, and would burn the job's retry budget on something that is not an error.
    expect(counts.recordsFailed).toBeUndefined();
    expect(counts.rateLimitedCt).toBe(1);
  });

  test("a daily cap is distinguishable from a per-second throttle", async () => {
    const connector = fakeConnector({ kind: "rate_limited", retryAfterMs: 3_600_000, daily: true });
    const r = await run({}, fakeDeps(), connector);
    expect(r.reason).toBe("daily_cap");
  });

  test("a validation error is a failure and does NOT record a push", async () => {
    const connector = fakeConnector({ kind: "validation", detail: { field: "Title" } });
    const recordPushed = mock(async () => {});
    const deps = fakeDeps({ recordPushed });

    const r = await run({}, deps, connector);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("validation");
    expect(recordPushed).not.toHaveBeenCalled();
    expect((deps as unknown as { counts: Record<string, number> }).counts.recordsFailed).toBe(1);
  });

  test("a per-record rejection inside an OK batch is still a failure", async () => {
    // The batch call succeeded; this row did not. Treating the HTTP 200 as success is the bug this covers.
    const connector = fakeConnector({
      kind: "ok",
      value: { perRecord: [{ externalId: "tp-uuid", outcome: "rejected" }] },
      limits: {},
    });
    const recordPushed = mock(async () => {});
    const deps = fakeDeps({ recordPushed });

    const r = await run({}, deps, connector);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe("rejected_by_crm");
    expect(recordPushed).not.toHaveBeenCalled();
  });

  test("an empty perRecord array is a failure, not a silent success", async () => {
    const connector = fakeConnector({ kind: "ok", value: { perRecord: [] }, limits: {} });
    const r = await run({}, fakeDeps(), connector);
    expect(r.outcome).toBe("failed");
  });

  test("a deleted TP entity is 'missing', not an error", async () => {
    const connector = fakeConnector();
    const deps = fakeDeps({ loadEntity: async () => null });
    const r = await run({}, deps, connector);
    expect(r.outcome).toBe("missing");
    expect(connector.upsert).not.toHaveBeenCalled();
  });
});

describe("the token is only decrypted when a real call will happen", () => {
  for (const [label, gates] of [
    ["gated", { envEnabled: false }],
    ["shadow", { syncMode: "shadow" as const }],
  ] as const) {
    test(`${label}: loadTokenBundle is never called`, async () => {
      const loadTokenBundle = mock(async () => ({
        accessToken: "tok",
        expiresAt: 0,
        scopes: [],
        environment: "production" as const,
      }));
      const deps = fakeDeps({ loadTokenBundle });
      await run(gates, deps, fakeConnector());
      // Decrypting a credential that is not about to be used is avoidable exposure — the plaintext would
      // sit in process memory for no reason.
      expect(loadTokenBundle).not.toHaveBeenCalled();
    });
  }
});
