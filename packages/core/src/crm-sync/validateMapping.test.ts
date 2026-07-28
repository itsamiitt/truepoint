// validateMapping.test.ts — the PURE CRM field-mapping validator (crm-sync §4.3). No DB: pure functions over
// plain objects. Covers the happy path and each error class — duplicate (object, tpField); unknown tpField;
// empty crmField; confThreshold outside [0,1] (incl. the inclusive 0/1 boundary); an enabled mapping with
// direction "disabled" — plus accumulation and that neither argument is mutated.

import { describe, expect, test } from "bun:test";
import type { CrmFieldMapping } from "@leadwolf/types";
import { validateCrmMappings } from "./validateMapping.ts";

const mapping = (
  over: Partial<CrmFieldMapping> & { tpField: string; crmField: string },
): CrmFieldMapping => ({
  objectType: "contact",
  direction: "bidirectional",
  transform: "passthrough",
  enabled: true,
  ...over,
});

const KNOWN = new Set(["email", "jobTitle", "name"]);

describe("validateCrmMappings", () => {
  test("returns no errors for a well-formed set", () => {
    const errors = validateCrmMappings(
      [
        mapping({ tpField: "email", crmField: "Email" }),
        mapping({ tpField: "jobTitle", crmField: "Title" }),
        mapping({ objectType: "account", tpField: "name", crmField: "Name" }),
      ],
      KNOWN,
    );
    expect(errors).toEqual([]);
  });

  test("flags a duplicate (object, tpField)", () => {
    const errors = validateCrmMappings(
      [
        mapping({ tpField: "email", crmField: "Email" }),
        mapping({ tpField: "email", crmField: "Email2" }),
      ],
      KNOWN,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("duplicate_tp_field");
    expect(errors[0]?.tpField).toBe("email");
  });

  test("the same tpField on a DIFFERENT object is not a duplicate", () => {
    const errors = validateCrmMappings(
      [
        mapping({ objectType: "contact", tpField: "email", crmField: "Email" }),
        mapping({ objectType: "account", tpField: "email", crmField: "Email" }),
      ],
      new Set(["email"]),
    );
    expect(errors).toEqual([]);
  });

  test("flags an unknown tpField", () => {
    const errors = validateCrmMappings([mapping({ tpField: "ghost", crmField: "Ghost" })], KNOWN);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("unknown_tp_field");
  });

  test("flags an empty / blank crmField", () => {
    const errors = validateCrmMappings([mapping({ tpField: "email", crmField: "   " })], KNOWN);
    expect(errors.map((e) => e.code)).toEqual(["empty_crm_field"]);
  });

  test("flags a confThreshold outside [0,1] but accepts the inclusive 0/1 boundary", () => {
    const low = validateCrmMappings(
      [mapping({ tpField: "email", crmField: "E", confThreshold: -0.1 })],
      KNOWN,
    );
    const high = validateCrmMappings(
      [mapping({ tpField: "email", crmField: "E", confThreshold: 1.5 })],
      KNOWN,
    );
    const edge = validateCrmMappings(
      [
        mapping({ tpField: "email", crmField: "E", confThreshold: 0 }),
        mapping({ objectType: "account", tpField: "name", crmField: "N", confThreshold: 1 }),
      ],
      KNOWN,
    );
    expect(low[0]?.code).toBe("conf_threshold_out_of_range");
    expect(high[0]?.code).toBe("conf_threshold_out_of_range");
    expect(edge).toEqual([]);
  });

  test("flags an ENABLED mapping with direction 'disabled' — but not a disabled one", () => {
    const enabled = validateCrmMappings(
      [mapping({ tpField: "email", crmField: "E", direction: "disabled" })],
      KNOWN,
    );
    const off = validateCrmMappings(
      [mapping({ tpField: "email", crmField: "E", direction: "disabled", enabled: false })],
      KNOWN,
    );
    expect(enabled.map((e) => e.code)).toEqual(["enabled_but_disabled"]);
    expect(off).toEqual([]);
  });

  test("accumulates multiple violations across rows", () => {
    const errors = validateCrmMappings(
      [
        mapping({ tpField: "ghost", crmField: "" }),
        mapping({ tpField: "email", crmField: "E", confThreshold: 9 }),
      ],
      KNOWN,
    );
    const codes = errors.map((e) => e.code).sort();
    expect(codes).toEqual(["conf_threshold_out_of_range", "empty_crm_field", "unknown_tp_field"]);
  });

  test("is pure — it mutates neither the mappings nor the known set", () => {
    const mappings = [mapping({ tpField: "email", crmField: "Email" })];
    const snapshot = JSON.stringify(mappings);
    const known = new Set(["email"]);
    validateCrmMappings(mappings, known);
    expect(JSON.stringify(mappings)).toBe(snapshot);
    expect([...known]).toEqual(["email"]);
  });
});
