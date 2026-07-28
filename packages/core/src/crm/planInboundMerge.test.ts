// planInboundMerge.test.ts — the PURE CRM→TP merge planner (crm-sync §6.1). No DB: pure functions over plain
// maps. Covers the §6.1 ladder: APPLY when the CRM is authoritative and the value changed; SKIP on an
// outbound-only field; SKIP on a no-op/echo (loop guard); CONFLICT on a pinned (human-edited) field (the
// live value is left untouched); per-field direction + authority honored (TP-authoritative fills a gap only);
// the last-write-wins tiebreak when authority is unset (conflict resolution); and the suppression gate.

import { describe, expect, test } from "bun:test";
import type { CrmFieldMapping, FieldProvenanceMap } from "@leadwolf/types";
import {
  type InboundMergeField,
  type InboundMergeInput,
  planCrmInboundMerge,
} from "./planInboundMerge.ts";

const mapping = (over: Partial<CrmFieldMapping> & { tpField: string }): CrmFieldMapping => ({
  objectType: "contact",
  crmField: over.tpField,
  direction: "inbound",
  authority: "crm",
  transform: "passthrough",
  enabled: true,
  ...over,
});

const field = (over: Partial<InboundMergeField> & { tpField: string }): InboundMergeField => ({
  value: "new",
  ...over,
});

const base = (over: Partial<InboundMergeInput> = {}): InboundMergeInput => ({
  provider: "hubspot",
  mappings: [mapping({ tpField: "jobTitle" })],
  incoming: [field({ tpField: "jobTitle", value: "VP Sales", obs: "2026-06-10T00:00:00Z", conf: 0.9 })],
  current: { jobTitle: "Director" },
  provenance: {},
  suppressed: false,
  ...over,
});

describe("planCrmInboundMerge", () => {
  test("APPLY a changed CRM-authoritative field and stamp crm provenance", () => {
    const plan = planCrmInboundMerge(base());

    expect(plan.writableFields.has("jobTitle")).toBe(true);
    expect(plan.values.jobTitle).toBe("VP Sales");
    expect(plan.provenance.jobTitle).toEqual({
      src: "crm:hubspot",
      mth: "crm_sync",
      obs: "2026-06-10T00:00:00Z",
      conf: 0.9,
      pin: false,
    });
  });

  test("SKIP an outbound-only field (never applied inbound)", () => {
    const plan = planCrmInboundMerge(
      base({ mappings: [mapping({ tpField: "jobTitle", direction: "outbound" })] }),
    );

    expect(plan.writableFields.size).toBe(0);
    expect(plan.outcomes[0]).toEqual({ tpField: "jobTitle", decision: "skip", reason: "skip" });
  });

  test("SKIP a no-op / echo (the incoming value equals the current value, case-insensitively)", () => {
    const plan = planCrmInboundMerge(
      base({ current: { jobTitle: "vp sales" }, incoming: [field({ tpField: "jobTitle", value: "VP Sales" })] }),
    );

    expect(plan.writableFields.size).toBe(0);
  });

  test("CONFLICT on a PINNED field — the live value is NOT clobbered", () => {
    const provenance: FieldProvenanceMap = {
      jobTitle: { src: "user_edit", pin: true, by: "user-1", at: "2026-06-01T00:00:00Z" },
    };
    const plan = planCrmInboundMerge(base({ provenance }));

    expect(plan.writableFields.size).toBe(0);
    expect(plan.conflicts).toEqual([
      { tpField: "jobTitle", tpValue: "Director", crmValue: "VP Sales" },
    ]);
    // descriptor left exactly as it was — the human correction survives
    expect(plan.provenance.jobTitle).toEqual(provenance.jobTitle);
  });

  test("a TP-authoritative field is filled only when the current value is blank", () => {
    const filled = planCrmInboundMerge(
      base({ mappings: [mapping({ tpField: "jobTitle", authority: "truepoint" })] }),
    );
    expect(filled.writableFields.size).toBe(0); // current is 'Director' → TP owns it, CRM may not overwrite

    const gap = planCrmInboundMerge(
      base({ current: { jobTitle: "" }, mappings: [mapping({ tpField: "jobTitle", authority: "truepoint" })] }),
    );
    expect(gap.writableFields.has("jobTitle")).toBe(true); // fill the gap
  });

  test("conflict resolution — authority unset falls back to last-write-wins on valid-time", () => {
    const provenance: FieldProvenanceMap = {
      jobTitle: { src: "provider:zoominfo", obs: "2026-06-20T00:00:00Z", pin: false },
    };
    const mappings = [mapping({ tpField: "jobTitle", authority: undefined })];

    const older = planCrmInboundMerge(
      base({ provenance, mappings, incoming: [field({ tpField: "jobTitle", value: "Old", obs: "2026-01-01T00:00:00Z" })] }),
    );
    expect(older.writableFields.size).toBe(0); // incoming is older → keep ours

    const newer = planCrmInboundMerge(
      base({ provenance, mappings, incoming: [field({ tpField: "jobTitle", value: "Newer", obs: "2026-12-01T00:00:00Z" })] }),
    );
    expect(newer.writableFields.has("jobTitle")).toBe(true); // incoming is newer → apply
  });

  test("SKIP everything when the subject is suppressed", () => {
    const plan = planCrmInboundMerge(base({ suppressed: true }));

    expect(plan.writableFields.size).toBe(0);
    expect(plan.outcomes[0].reason).toBe("suppressed");
  });

  test("does not mutate the existing provenance map", () => {
    const provenance: FieldProvenanceMap = { jobTitle: { src: "provider:apollo", pin: false } };
    planCrmInboundMerge(base({ provenance }));

    expect(provenance.jobTitle).toEqual({ src: "provider:apollo", pin: false });
  });
});
