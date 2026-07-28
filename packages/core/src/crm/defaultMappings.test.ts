// defaultMappings.test.ts — the out-of-box CRM field-mapping presets (crm-sync §4.3). No DB: pure data over the
// shared contract. Proves every preset is a well-formed CrmFieldMapping, references a REAL contacts/accounts
// schema field, and passes validateCrmMappings; that the three §4.3/§6.1/§6.2 buckets (bidirectional identity /
// outbound TruePoint-authoritative / inbound CRM-authoritative) are present; and that defaultMappingsFor
// narrows by object and hands back a mutation-safe copy.

import { describe, expect, test } from "bun:test";
import { crmFieldMappingSchema, crmProvider } from "@leadwolf/types";
import { DEFAULT_CRM_FIELD_MAPPINGS, defaultMappingsFor } from "./defaultMappings.ts";
import { validateCrmMappings } from "./validateMapping.ts";

// The real TruePoint columns the presets may target — contacts + accounts (packages/db/src/schema/contacts.ts).
// `email`/`phone` are the logical PII fields (stored encrypted as email_enc/phone_enc); the rest are columns
// verbatim. This doubles as the known-field set the presets are validated against.
const REAL_TP_FIELDS = new Set<string>([
  // contacts
  "email",
  "firstName",
  "lastName",
  "jobTitle",
  "seniorityLevel",
  "department",
  "phone",
  "linkedinUrl",
  "locationCountry",
  "locationCity",
  "outreachStatus",
  "emailDomain",
  "emailStatus",
  "phoneStatus",
  // accounts
  "name",
  "domain",
  "industry",
  "subIndustry",
  "employeeCount",
  "revenueRange",
  "hqCountry",
  "hqCity",
  "fundingStage",
  "companyStage",
  "foundedYear",
]);

const find = (provider: "hubspot" | "salesforce", objectType: string, tpField: string) =>
  DEFAULT_CRM_FIELD_MAPPINGS[provider].find(
    (m) => m.objectType === objectType && m.tpField === tpField,
  );

describe("DEFAULT_CRM_FIELD_MAPPINGS", () => {
  for (const provider of crmProvider.options) {
    const mappings = DEFAULT_CRM_FIELD_MAPPINGS[provider];

    test(`${provider}: every preset is a well-formed CrmFieldMapping`, () => {
      expect(mappings.length).toBeGreaterThan(0);
      for (const m of mappings) {
        expect(crmFieldMappingSchema.safeParse(m).success).toBe(true);
      }
    });

    test(`${provider}: every preset references a real TruePoint schema field`, () => {
      for (const m of mappings) {
        expect(REAL_TP_FIELDS.has(m.tpField)).toBe(true);
      }
    });

    test(`${provider}: every preset passes validateCrmMappings`, () => {
      expect(validateCrmMappings(mappings, REAL_TP_FIELDS)).toEqual([]);
    });

    test(`${provider}: covers both contact and account objects`, () => {
      expect(mappings.some((m) => m.objectType === "contact")).toBe(true);
      expect(mappings.some((m) => m.objectType === "account")).toBe(true);
    });
  }

  test("identity fields are bidirectional with the authority left to the LWW tiebreak", () => {
    for (const provider of crmProvider.options) {
      const email = find(provider, "contact", "email");
      expect(email?.direction).toBe("bidirectional");
      expect(email?.authority).toBeUndefined();
      expect(email?.isDedupKey).toBe(true);
    }
  });

  test("enriched fields are outbound with authority 'truepoint' + a confidence gate", () => {
    for (const provider of crmProvider.options) {
      const phone = find(provider, "contact", "phone");
      expect(phone?.direction).toBe("outbound");
      expect(phone?.authority).toBe("truepoint");
      expect(phone?.confThreshold).toBe(0.7);
      expect(phone?.transform).toBe("phone_e164");
    }
  });

  test("CRM-owned process fields are inbound with authority 'crm' (lifecycle stage)", () => {
    const lifecycle = find("hubspot", "contact", "outreachStatus");
    expect(lifecycle?.crmField).toBe("lifecyclestage");
    expect(lifecycle?.direction).toBe("inbound");
    expect(lifecycle?.authority).toBe("crm");
    expect(lifecycle?.transform).toBe("picklist_map");
  });
});

describe("defaultMappingsFor", () => {
  test("narrows to a single object", () => {
    const accounts = defaultMappingsFor("hubspot", "account");
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.every((m) => m.objectType === "account")).toBe(true);
  });

  test("returns a mutation-safe copy of the preset constant", () => {
    const before = DEFAULT_CRM_FIELD_MAPPINGS.salesforce.length;
    const copy = defaultMappingsFor("salesforce");
    copy.pop();
    expect(DEFAULT_CRM_FIELD_MAPPINGS.salesforce.length).toBe(before);
  });
});
