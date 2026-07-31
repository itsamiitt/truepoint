// importProvenance.test.ts — what an import row ASSERTS about the Layer-0 graph. Pure, no database.
//
// The wiring itself (same-transaction append, the ev.created guard, the fatal-when-gated posture) is proven
// against a real Postgres in packages/db/test; this covers the decision of what goes into each draft, which is
// where a quiet mistake would be hardest to notice — a wrong field set does not fail anything, it just makes
// the confidence signal wrong forever.

import { describe, expect, test } from "bun:test";
import { provenanceEventDraftSchema } from "@leadwolf/types";
import { type RunImportInput, importProvenanceDrafts } from "./runImport.ts";

const MASTER_PERSON = "11111111-1111-4111-8111-111111111111";
const MASTER_COMPANY = "44444444-4444-4444-8444-444444444444";
const SOURCE_RECORD = "55555555-5555-4555-8555-555555555555";

const input = {
  scope: { tenantId: "t", workspaceId: "w" },
  sourceName: "apollo",
  mapping: {},
  rows: [],
} as unknown as RunImportInput;

/** Only the fields the builder reads; `values` is keyed exactly as CONTACT_PROVENANCE_FIELDS. */
const prepared = {
  values: {
    firstName: "Jane",
    lastName: "Prospect",
    jobTitle: "VP Sales",
    department: null, // present but empty — must not be asserted
    emailDomain: "example.com", // not a provenance-tracked scalar
  },
  accountName: "Northwind Traders",
  accountDomain: "northwind.com",
  // biome-ignore lint/suspicious/noExplicitAny: a narrow fixture, not the full PreparedContact surface
} as any;

const resolved = { masterPersonId: MASTER_PERSON, masterCompanyId: MASTER_COMPANY };

describe("importProvenanceDrafts", () => {
  test("asserts the populated provenance-tracked scalars and nothing else", () => {
    const drafts = importProvenanceDrafts(input, resolved, prepared, SOURCE_RECORD);
    const person = drafts.filter((d) => d.entityType === "person").map((d) => d.field);
    expect(person.sort()).toEqual(["firstName", "jobTitle", "lastName"]);
    // `department` is null: an import that carried no value asserted nothing about it, and recording an event
    // would claim a source vouched for a blank.
    expect(person).not.toContain("department");
    // `emailDomain` is a facet, not one of the seven pin-protected scalars — one vocabulary across both layers.
    expect(person).not.toContain("emailDomain");
  });

  test("asserts the company firmographics an import actually carries", () => {
    const drafts = importProvenanceDrafts(input, resolved, prepared, SOURCE_RECORD);
    const company = drafts.filter((d) => d.entityType === "company").map((d) => d.field);
    expect(company.sort()).toEqual(["domain", "name"]);
  });

  test("every draft is Layer-0 shaped, schema-valid, and carries its lineage", () => {
    const drafts = importProvenanceDrafts(input, resolved, prepared, SOURCE_RECORD);
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) {
      // No workspace hint on Layer-0 rows — the CHECK in 0089 enforces the same thing at the database.
      expect(d.scopeRef).toBeNull();
      expect(d.sourceRecordId).toBe(SOURCE_RECORD);
      expect(d.sourceType).toBe("import");
      expect(d.sourceName).toBe("import:apollo");
      expect(provenanceEventDraftSchema.safeParse(d).success).toBe(true);
    }
  });

  test("no contributor ref is attached to an import", () => {
    // Imports are not contributions. Attaching a ref here would put identity on rows no human vouched for.
    const drafts = importProvenanceDrafts(input, resolved, prepared, SOURCE_RECORD);
    expect(drafts.every((d) => d.contributorRef === null)).toBe(true);
  });

  test("the default lawful basis applies when the workspace configured none", () => {
    const drafts = importProvenanceDrafts(input, resolved, prepared, SOURCE_RECORD);
    expect(drafts.every((d) => d.lawfulBasis === "legitimate_interest")).toBe(true);
  });

  test("a workspace-configured basis is used instead", () => {
    const drafts = importProvenanceDrafts(
      { ...input, lawfulBasis: "contract" },
      resolved,
      prepared,
      SOURCE_RECORD,
    );
    expect(drafts.every((d) => d.lawfulBasis === "contract")).toBe(true);
  });

  test("an unresolved master id produces no events for that layer", () => {
    // The bridge is nullable in-flight; asserting against a null entity would be an event about nothing.
    const personOnly = importProvenanceDrafts(
      input,
      { masterPersonId: MASTER_PERSON, masterCompanyId: null },
      prepared,
      SOURCE_RECORD,
    );
    expect(personOnly.some((d) => d.entityType === "company")).toBe(false);

    const neither = importProvenanceDrafts(
      input,
      { masterPersonId: null, masterCompanyId: null },
      prepared,
      SOURCE_RECORD,
    );
    expect(neither).toEqual([]);
  });

  test("a row carrying no company details asserts no company fields", () => {
    const noCompany = importProvenanceDrafts(
      input,
      resolved,
      { ...prepared, accountName: undefined, accountDomain: undefined },
      SOURCE_RECORD,
    );
    expect(noCompany.some((d) => d.entityType === "company")).toBe(false);
  });
});
