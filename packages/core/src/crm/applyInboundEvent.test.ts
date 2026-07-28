// applyInboundEvent.test.ts — the CRM→TP apply runner (crm-sync 00 §3.3 inbound / §6.1). Injected
// dependencies, so this drives the real runner with no database and no network.
//
// The load-bearing assertions are about what the runner REFUSES to do with an untrusted webhook:
//   - it re-fetches over the connection instead of trusting the payload;
//   - it will not re-create a suppressed subject;
//   - it drops its own echo before spending an API call;
//   - and shadow mode reaches no write.

import { describe, expect, mock, test } from "bun:test";
import type { CrmFieldMapping } from "@leadwolf/types";
import {
  type ApplyInboundEventInput,
  type CrmInboundDeps,
  type CrmInboundGates,
  applyInboundEvent,
} from "./applyInboundEvent.ts";
import type { CrmConnector } from "./port.ts";

const MAPPINGS: CrmFieldMapping[] = [
  {
    objectType: "contact",
    tpField: "jobTitle",
    crmField: "Title",
    direction: "inbound",
    authority: "crm",
    transform: "passthrough",
    enabled: true,
  },
];

const CRM_RECORD = { Title: "VP Sales", Phone: "+14155552671" };

function fakeConnector(record: unknown = CRM_RECORD) {
  const fetchOne = mock(async () => ({
    kind: "ok" as const,
    value: { record },
    limits: {},
  }));
  return { provider: "salesforce", configured: true, fetchOne } as unknown as CrmConnector & {
    fetchOne: ReturnType<typeof mock>;
  };
}

function fakeDeps(over: Partial<CrmInboundDeps> = {}) {
  const counts: Record<string, number> = {};
  const deps: CrmInboundDeps & { counts: Record<string, number> } = {
    counts,
    loadMappings: async () => MAPPINGS,
    loadTokenBundle: async () => ({
      accessToken: "tok",
      expiresAt: 0,
      scopes: [],
      environment: "production" as const,
    }),
    resolveEntity: async () => ({ entityId: "contact-1", linkId: "link-1" }),
    isSuppressed: async () => false,
    loadCurrent: async () => ({ values: { jobTitle: "Director" }, provenance: {} }),
    persist: async ({ entityId }) => entityId ?? "contact-new",
    recordConflicts: async () => {},
    linkRecord: async () => {},
    addCounts: async (c) => {
      for (const [k, v] of Object.entries(c)) counts[k] = (counts[k] ?? 0) + v;
    },
    ...over,
  };
  return deps;
}

const GATES: CrmInboundGates = { envEnabled: true, tenantFlagEnabled: true, syncMode: "enforce" };

function run(
  over: Partial<ApplyInboundEventInput> = {},
  deps = fakeDeps(),
  // Typed as the plain port, not the fake's narrowed shape: one test supplies a connector that only
  // implements fetchOne, and inferring the default's mock-bearing type would reject it.
  connector: CrmConnector = fakeConnector(),
) {
  return applyInboundEvent({
    provider: "salesforce",
    objectType: "contact",
    crmRecordId: "SFDC-1",
    modstamp: new Date(Date.parse("2026-06-10T00:00:00Z")),
    gates: GATES,
    connector,
    deps,
    ...over,
  });
}

describe("the gate ladder", () => {
  for (const [label, gates, reason] of [
    ["L1 env", { ...GATES, envEnabled: false }, "env_disabled"],
    ["L2 tenant flag", { ...GATES, tenantFlagEnabled: false }, "tenant_flag_off"],
    ["L3 connection", { ...GATES, syncMode: "disabled" as const }, "connection_disabled"],
  ] as const) {
    test(`${label}: refused, and no CRM fetch happens`, async () => {
      const connector = fakeConnector();
      const r = await run({ gates }, fakeDeps(), connector);
      expect(r.outcome).toBe("gated");
      expect(r.reason).toBe(reason);
      expect(connector.fetchOne).not.toHaveBeenCalled();
    });
  }
});

describe("the payload is a hint, never the data", () => {
  test("the record is RE-FETCHED over the connection", async () => {
    const connector = fakeConnector();
    await run({}, fakeDeps(), connector);
    // The webhook contributed only the id. Everything written comes from this authenticated call, which is
    // what stops a forged webhook body from choosing what we write.
    expect(connector.fetchOne).toHaveBeenCalledTimes(1);
    const arg = connector.fetchOne.mock.calls[0]?.[0] as { externalId: string };
    expect(arg.externalId).toBe("SFDC-1");
  });

  test("a record deleted between the event and the fetch is 'not_found', not an error", async () => {
    const connector = fakeConnector(null);
    const r = await run({}, fakeDeps(), connector);
    expect(r.outcome).toBe("not_found");
  });

  test("a failed fetch is a failure and writes nothing", async () => {
    const fetchOne = mock(async () => ({ kind: "transient" as const, status: 503 }));
    const connector = {
      provider: "salesforce",
      configured: true,
      fetchOne,
    } as unknown as CrmConnector;
    const persist = mock(async () => "x");
    const r = await run({}, fakeDeps({ persist }), connector);
    expect(r.outcome).toBe("failed");
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("the suppression wall faces inward", () => {
  test("an erased subject is NOT re-created by an inbound sync", async () => {
    // The DSAR tombstone is worthless if the next sync tick pulls the person back in. This is that wall.
    const persist = mock(async () => "x");
    const linkRecord = mock(async () => {});
    const deps = fakeDeps({ isSuppressed: async () => true, persist, linkRecord });

    const r = await run({}, deps);
    expect(r.outcome).toBe("suppressed");
    expect(persist).not.toHaveBeenCalled();
    expect(linkRecord).not.toHaveBeenCalled();
  });

  test("suppression is judged on the INCOMING values, not on an already-resolved entity", async () => {
    const isSuppressed = mock(async (_v: Record<string, unknown>) => false);
    const resolveEntity = mock(async () => ({ entityId: "c1", linkId: null }));
    await run({}, fakeDeps({ isSuppressed, resolveEntity }));
    // Checked BEFORE resolution: a suppressed identity must be refused even when it matches nothing we
    // hold, or an erased person simply gets re-created as a brand-new contact.
    expect(isSuppressed).toHaveBeenCalled();
    const order = (isSuppressed.mock.invocationCallOrder?.[0] ?? 0) as number;
    const resolveOrder = (resolveEntity.mock.invocationCallOrder?.[0] ?? 0) as number;
    expect(order).toBeLessThan(resolveOrder);
  });
});

describe("loop prevention", () => {
  test("our own origin tag is dropped BEFORE any API call is spent", async () => {
    const connector = fakeConnector();
    const deps = fakeDeps();
    const r = await run({ sourceTag: "truepoint", ownSourceTag: "truepoint" }, deps, connector);
    expect(r.outcome).toBe("echo");
    expect(connector.fetchOne).not.toHaveBeenCalled();
    expect((deps as unknown as { counts: Record<string, number> }).counts.apiCalls).toBeUndefined();
  });

  test("a DIFFERENT origin tag is a real change and proceeds", async () => {
    const connector = fakeConnector();
    const r = await run({ sourceTag: "a-human", ownSourceTag: "truepoint" }, fakeDeps(), connector);
    expect(r.outcome).not.toBe("echo");
    expect(connector.fetchOne).toHaveBeenCalled();
  });
});

describe("shadow mode", () => {
  test("plans and reports but writes nothing", async () => {
    const persist = mock(async () => "x");
    const linkRecord = mock(async () => {});
    const deps = fakeDeps({ persist, linkRecord });

    const r = await run({ gates: { ...GATES, syncMode: "shadow" } }, deps);
    expect(r.outcome).toBe("shadowed");
    expect(r.appliedFields).toContain("jobTitle");
    expect(persist).not.toHaveBeenCalled();
    expect(linkRecord).not.toHaveBeenCalled();
  });
});

describe("enforce mode", () => {
  test("applies to an existing entity and links the record", async () => {
    const linkRecord = mock(async () => {});
    const deps = fakeDeps({ linkRecord });
    const r = await run({}, deps);

    expect(r.outcome).toBe("applied");
    expect(r.entityId).toBe("contact-1");
    expect(r.appliedFields).toContain("jobTitle");
    expect(linkRecord).toHaveBeenCalledTimes(1);
    const counts = (deps as unknown as { counts: Record<string, number> }).counts;
    expect(counts.recordsUpdated).toBe(1);
    expect(counts.recordsMatched).toBe(1);
  });

  test("an unresolved record CREATES, and is counted as a creation not an update", async () => {
    const deps = fakeDeps({ resolveEntity: async () => null });
    const r = await run({}, deps);
    expect(r.outcome).toBe("created");
    expect((deps as unknown as { counts: Record<string, number> }).counts.recordsCreated).toBe(1);
  });

  test("a pinned field routes to review and does NOT clobber the live value", async () => {
    // planCrmInboundMerge stages a pinned (human-edited) field as a conflict; the runner must persist the
    // conflict and leave the field alone.
    const recordConflicts = mock(async () => {});
    const deps = fakeDeps({
      recordConflicts,
      loadCurrent: async () => ({
        values: { jobTitle: "Director" },
        provenance: { jobTitle: { src: "user_edit", pin: true } },
      }),
    });

    const r = await run({}, deps);
    expect(r.conflicts).toBe(1);
    expect(recordConflicts).toHaveBeenCalledTimes(1);
    expect(r.appliedFields).not.toContain("jobTitle");
  });

  test("nothing writable and nothing conflicting is a skip, not an empty write", async () => {
    const persist = mock(async () => "x");
    const deps = fakeDeps({
      persist,
      // The CRM value equals what we already hold — the planner's echo guard skips it.
      loadCurrent: async () => ({ values: { jobTitle: "VP Sales" }, provenance: {} }),
    });
    const r = await run({}, deps);
    expect(r.outcome).toBe("skipped");
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("per-field transform refusals", () => {
  test("a bad value is reported per field and does not fail the record", async () => {
    const mappings: CrmFieldMapping[] = [
      ...MAPPINGS,
      {
        objectType: "contact",
        tpField: "phone",
        crmField: "Phone",
        direction: "inbound",
        authority: "crm",
        transform: "phone_e164",
        enabled: true,
      },
    ];
    const connector = fakeConnector({ Title: "VP Sales", Phone: "not-a-phone" });
    const deps = fakeDeps({ loadMappings: async () => mappings });

    const r = await run({}, deps, connector);
    expect(r.refusedFields).toEqual([{ tpField: "phone", reason: "unparseable_phone" }]);
    // The record still synced everything else — one unparseable phone is not a failed record.
    expect(r.outcome).toBe("applied");
    expect(r.appliedFields).toContain("jobTitle");
    expect(
      (deps as unknown as { counts: Record<string, number> }).counts.recordsFailed,
    ).toBeUndefined();
  });
});
