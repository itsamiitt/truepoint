// planOutboundPush.test.ts — the PURE TP→CRM push planner (crm-sync §6.2). No DB: pure functions over plain
// objects. Covers the load-bearing decisions: a create (no link), an update (link + changed fields), the
// skips (suppressed / nothing to push / unchanged content hash / loop-detected echo), per-field direction +
// authority honored, and the confidence-threshold gate.

import { describe, expect, test } from "bun:test";
import type { CrmFieldMapping, FieldProvenanceMap } from "@leadwolf/types";
import { type OutboundPushInput, planCrmOutboundPush } from "./planOutboundPush.ts";

const mapping = (over: Partial<CrmFieldMapping> & { tpField: string; crmField: string }): CrmFieldMapping => ({
  objectType: "contact",
  direction: "outbound",
  transform: "passthrough",
  enabled: true,
  ...over,
});

const base = (over: Partial<OutboundPushInput> = {}): OutboundPushInput => ({
  provider: "hubspot",
  mappings: [mapping({ tpField: "jobTitle", crmField: "jobtitle" })],
  values: { jobTitle: "VP Sales" },
  provenance: {},
  link: null,
  suppressed: false,
  ...over,
});

describe("planCrmOutboundPush", () => {
  test("CREATE when there is no link and a field is pushable", () => {
    const plan = planCrmOutboundPush(base());

    expect(plan.operation).toBe("create");
    expect(plan.fields).toEqual(["jobTitle"]);
    expect(plan.payload).toEqual({ jobtitle: "VP Sales" });
    expect(plan.contentHash.length).toBeGreaterThan(0);
  });

  test("UPDATE when a link exists with a different last-synced hash", () => {
    const plan = planCrmOutboundPush(base({ link: { lastSyncedHash: "stale-hash" } }));

    expect(plan.operation).toBe("update");
    expect(plan.fields).toEqual(["jobTitle"]);
  });

  test("SKIP (unchanged) when the content hash equals the link's last-synced hash", () => {
    const first = planCrmOutboundPush(base());
    const plan = planCrmOutboundPush(base({ link: { lastSyncedHash: first.contentHash } }));

    expect(plan.operation).toBe("skip");
    expect(plan.reason).toBe("unchanged");
    expect(plan.fields).toEqual([]);
  });

  test("SKIP (suppressed) refuses to push a suppressed subject", () => {
    const plan = planCrmOutboundPush(base({ suppressed: true }));

    expect(plan.operation).toBe("skip");
    expect(plan.reason).toBe("suppressed");
  });

  test("per-field direction is honored — an inbound-only field is never pushed", () => {
    const plan = planCrmOutboundPush(
      base({ mappings: [mapping({ tpField: "jobTitle", crmField: "jobtitle", direction: "inbound" })] }),
    );

    expect(plan.operation).toBe("skip");
    expect(plan.reason).toBe("no_pushable_fields");
  });

  test("a CRM-authoritative field is never pushed (the CRM is the system of record)", () => {
    const plan = planCrmOutboundPush(
      base({ mappings: [mapping({ tpField: "jobTitle", crmField: "jobtitle", authority: "crm" })] }),
    );

    expect(plan.reason).toBe("no_pushable_fields");
  });

  test("loop guard — a field whose winning src is THIS CRM is not pushed back", () => {
    const provenance: FieldProvenanceMap = { jobTitle: { src: "crm:hubspot", pin: false } };
    const plan = planCrmOutboundPush(base({ provenance }));

    expect(plan.operation).toBe("skip");
    expect(plan.reason).toBe("no_pushable_fields");
  });

  test("a field from a DIFFERENT CRM is still pushable (echo guard is per-provider)", () => {
    const provenance: FieldProvenanceMap = { jobTitle: { src: "crm:salesforce", pin: false } };
    const plan = planCrmOutboundPush(base({ provenance }));

    expect(plan.operation).toBe("create");
    expect(plan.fields).toEqual(["jobTitle"]);
  });

  test("the confidence threshold gates low-confidence enrichment out of the CRM", () => {
    const provenance: FieldProvenanceMap = { jobTitle: { src: "provider:zoominfo", conf: 0.4, pin: false } };
    const plan = planCrmOutboundPush(
      base({ provenance, mappings: [mapping({ tpField: "jobTitle", crmField: "jobtitle", confThreshold: 0.8 })] }),
    );

    expect(plan.reason).toBe("no_pushable_fields");
  });

  test("does not mutate the input values map", () => {
    const input = base();
    planCrmOutboundPush(input);

    expect(input.values).toEqual({ jobTitle: "VP Sales" });
  });
});
