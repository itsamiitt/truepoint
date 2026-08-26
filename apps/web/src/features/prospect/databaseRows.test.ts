// databaseRows.test.ts — the seam between the two search engines: which clauses cross to the global query,
// and how the two halves' rows are merged.
//
// The merge rules look like bookkeeping and are not. Each one encodes which engine is the source of truth
// for a given row, and getting it wrong makes people disappear from a search that should find them — or,
// after a reveal-as-save, makes the person the user just paid for jump or vanish mid-read.

import { describe, expect, test } from "bun:test";
import type { ContactQuery, MaskedContact, MaskedDatabasePerson } from "@leadwolf/types";
import {
  countDatabaseRows,
  databasePersonToRow,
  mergeRows,
  ownedRowFromDatabase,
  toDatabaseQuery,
} from "./databaseRows.ts";

const BASE: ContactQuery = { filters: [], sort: "relevance", limit: 50 };

function person(over: Partial<MaskedDatabasePerson> = {}): MaskedDatabasePerson {
  return {
    linkedinPublicId: "jane-doe",
    linkedinUrl: "https://linkedin.com/in/jane-doe",
    fullName: "Jane Doe",
    firstName: "Jane",
    lastName: "Doe",
    headline: null,
    jobTitle: "Engineer",
    seniorityLevel: null,
    locationRaw: null,
    locationCity: null,
    locationCountry: null,
    companyName: "Acme",
    companyDomain: "acme.com",
    companyIndustry: null,
    hasEmail: true,
    hasPhone: false,
    updatedAt: "2026-08-01T00:00:00.000Z",
    inWorkspace: null,
    ...over,
  } as MaskedDatabasePerson;
}

function contact(over: Partial<MaskedContact> = {}): MaskedContact {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    firstName: "Owned",
    lastName: "Person",
    jobTitle: null,
    emailDomain: null,
    emailStatus: "unverified",
    phoneStatus: null,
    hasEmail: false,
    hasPhone: false,
    seniorityLevel: null,
    department: null,
    locationCountry: null,
    locationCity: null,
    outreachStatus: "new",
    isRevealed: false,
    ownerUserId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    lastVerifiedAt: null,
    ...over,
  } as MaskedContact;
}

const IN_WORKSPACE = { contactId: "22222222-2222-4222-8222-222222222222", isRevealed: true };
const NEW_ID = "33333333-3333-4333-8333-333333333333";

describe("mergeRows — normal mode (both halves ran)", () => {
  test("a database person the workspace already holds is dropped", () => {
    // The workspace half supplied them, so keeping the global copy would render the person twice.
    const rows = mergeRows([], [person({ inWorkspace: IN_WORKSPACE })]);
    expect(rows).toHaveLength(0);
  });

  test("a person matched by slug to an owned row is dropped", () => {
    const rows = mergeRows([contact({ linkedinPublicId: "jane-doe" })], [person()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.databaseSlug).toBeUndefined();
  });

  test("a person the workspace does not hold is kept and marked", () => {
    const rows = mergeRows([], [person()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.databaseSlug).toBe("jane-doe");
  });
});

describe("mergeRows — workspace half skipped (a database-only filter)", () => {
  test("an owned person is KEPT, not dropped", () => {
    // The whole point. A satellite filter (skill, school, past employer) cannot run against the overlay, so
    // the workspace half supplies nothing. Dropping in-workspace matches here would mean searching
    // "ex-Stripe people" and getting back everyone EXCEPT the ex-Stripe people already in your workspace.
    const rows = mergeRows([], [person({ inWorkspace: IN_WORKSPACE })], true);
    expect(rows).toHaveLength(1);
  });

  test("…and reads as an owned row, not as a database one", () => {
    // No databaseSlug ⇒ no "Not saved" chip and owned affordances for a contact already in the workspace.
    const rows = mergeRows([], [person({ inWorkspace: IN_WORKSPACE })], true);
    expect(rows[0]?.databaseSlug).toBeUndefined();
    expect(rows[0]?.id).toBe(IN_WORKSPACE.contactId);
    expect(rows[0]?.isRevealed).toBe(true);
  });

  test("a person the workspace does not hold is still a database row", () => {
    const rows = mergeRows([], [person()], true);
    expect(rows[0]?.databaseSlug).toBe("jane-doe");
    expect(rows[0]?.id).toBe("db:jane-doe");
  });
});

describe("reveal IS the save gesture — the in-place flip (decisions.md 2026-08-25)", () => {
  const saved = ownedRowFromDatabase(
    databasePersonToRow(person()),
    NEW_ID,
    { hasEmail: true, hasPhone: true },
    "email",
  );

  test("ownedRowFromDatabase turns the database row into an OWNED row with the platform's presence", () => {
    expect(saved.id).toBe(NEW_ID);
    expect(saved.databaseSlug).toBeUndefined();
    expect(saved.databaseUrl).toBeUndefined();
    expect(saved.isRevealed).toBe(true);
    expect(saved.revealedTypes).toEqual(["email"]);
    // The OTHER channel stays on offer: the response said a phone is on file even though the person's
    // masked row said no — the platform's booleans win over the search projection's.
    expect(saved.hasPhone).toBe(true);
    // Identity is kept, so the row does not visibly change shape.
    expect(saved.linkedinPublicId).toBe("jane-doe");
    expect(saved.firstName).toBe("Jane");
  });

  test("a reveal that FAILED after the landing still saves — unrevealed, button intact", () => {
    const unrevealed = ownedRowFromDatabase(
      databasePersonToRow(person()),
      NEW_ID,
      undefined,
      undefined,
    );
    expect(unrevealed.id).toBe(NEW_ID);
    expect(unrevealed.databaseSlug).toBeUndefined();
    expect(unrevealed.isRevealed).toBe(false);
    expect(unrevealed.revealedTypes).toEqual([]);
    // No presence in a failed response: the row's own bits stand.
    expect(unrevealed.hasEmail).toBe(true);
    expect(unrevealed.hasPhone).toBe(false);
  });

  test("a materialized person renders IN PLACE of their database row", () => {
    const rows = mergeRows([], [person()], false, new Map([["jane-doe", saved]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(NEW_ID);
    expect(rows[0]?.databaseSlug).toBeUndefined();
  });

  test("…even once the database half refetches and reports them as in the workspace", () => {
    // Without this the row would vanish from the grid (the normal dedup drops in-workspace people) until
    // the OWNED half refetched — the person the user just paid for, gone mid-read.
    const rows = mergeRows(
      [],
      [person({ inWorkspace: { contactId: NEW_ID, isRevealed: true } })],
      false,
      new Map([["jane-doe", saved]]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(NEW_ID);
  });

  test("an owned refetch that lists the person wins — the copy is dropped, no duplicate", () => {
    const rows = mergeRows(
      [contact({ id: NEW_ID, linkedinPublicId: "jane-doe", isRevealed: true })],
      [person({ inWorkspace: { contactId: NEW_ID, isRevealed: true } })],
      false,
      new Map([["jane-doe", saved]]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(NEW_ID);
  });

  test("countDatabaseRows counts only rows still addressed by slug", () => {
    const rows = mergeRows(
      [contact()],
      [
        person(),
        person({ linkedinPublicId: "john-roe", linkedinUrl: "https://linkedin.com/in/john-roe" }),
      ],
      false,
      new Map([["jane-doe", saved]]),
    );
    expect(rows).toHaveLength(3);
    expect(countDatabaseRows(rows)).toBe(1);
  });
});

describe("toDatabaseQuery", () => {
  test("a database-only field CROSSES rather than nulling the global query", () => {
    // The inverse of the workspace-only case: these are the only fields that can answer, so the global
    // query must carry them.
    const { query, droppedFields } = toDatabaseQuery(
      {
        ...BASE,
        filters: [{ kind: "term", field: "skill", op: "include", values: ["Kubernetes"] }],
      },
      25,
    );
    expect(droppedFields).toEqual([]);
    expect(query?.filters).toEqual([
      { kind: "term", field: "skill", op: "include", values: ["Kubernetes"] },
    ]);
  });

  test("a workspace-only field still skips the global half and names itself", () => {
    const { query, droppedFields } = toDatabaseQuery(
      { ...BASE, filters: [{ kind: "term", field: "owner", op: "include", values: ["me"] }] },
      25,
    );
    expect(query).toBeNull();
    expect(droppedFields).toEqual(["owner"]);
  });

  test("an exclude clause keeps its sense", () => {
    const { query } = toDatabaseQuery(
      {
        ...BASE,
        filters: [{ kind: "term", field: "industry", op: "exclude", values: ["Retail"] }],
      },
      25,
    );
    expect(query?.filters[0]).toMatchObject({ kind: "term", op: "exclude", values: ["Retail"] });
  });
});
