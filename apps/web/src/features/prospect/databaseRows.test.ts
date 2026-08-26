// databaseRows.test.ts — the seam that decides whether the database half of the People grid runs, and how a
// row flips after reveal-as-save. Pins the metric behind the quick-filter tier (every shared facet crosses,
// every workspace-only one skips the half rather than mis-answering it) and the in-place flip [S-06][S-10].
import { describe, expect, test } from "bun:test";
import type { ContactQuery, MaskedContact, MaskedDatabasePerson } from "@leadwolf/types";
import {
  SHARED_BOOL_FIELDS,
  SHARED_TERM_FIELDS,
  countDatabaseRows,
  databasePersonToRow,
  mergeRows,
  ownedRowFromDatabase,
  toDatabaseQuery,
} from "./databaseRows";

const person = (slug: string, over: Partial<MaskedDatabasePerson> = {}): MaskedDatabasePerson => ({
  linkedinPublicId: slug,
  linkedinUrl: `https://www.linkedin.com/in/${slug}`,
  fullName: "Jane Doe",
  firstName: "Jane",
  lastName: "Doe",
  headline: null,
  jobTitle: "VP Sales",
  seniorityLevel: "vp",
  locationRaw: "Bengaluru",
  locationCity: null,
  locationCountry: null,
  companyName: "Example",
  companyDomain: "example.com",
  companyIndustry: null,
  hasEmail: true,
  hasPhone: false,
  updatedAt: "2026-08-25T00:00:00.000Z",
  inWorkspace: null,
  ...over,
});

/** A workspace contact for `slug` (the shape the owned search returns). */
function ownedContact(slug: string, id: string): MaskedContact {
  const { databaseSlug: _s, databaseUrl: _u, ...base } = databasePersonToRow(person(slug));
  return { ...base, id, isRevealed: true, revealedTypes: ["email"] };
}

const query = (filters: ContactQuery["filters"]): ContactQuery =>
  ({ text: undefined, filters, sort: "relevance", limit: 50 }) as ContactQuery;

describe("toDatabaseQuery — the database half runs exactly when the query is answerable", () => {
  test("every shared term facet crosses, with its include/exclude sense", () => {
    const fields = SHARED_TERM_FIELDS as ReadonlySet<
      "title" | "company" | "location" | "seniority" | "industry"
    >;
    for (const field of fields) {
      for (const op of ["include", "exclude"] as const) {
        const q = query([{ kind: "term", field, op, values: ["x"] }]);
        const db = toDatabaseQuery(q, 25);
        expect(db).not.toBeNull();
        expect(db?.filters).toEqual([{ kind: "term", field, op, values: ["x"] }]);
        expect(db?.limit).toBe(25);
      }
    }
  });

  test("every shared bool facet crosses", () => {
    for (const field of SHARED_BOOL_FIELDS as ReadonlySet<"has_email" | "has_phone">) {
      const db = toDatabaseQuery(query([{ kind: "bool", field, value: true }]), 25);
      expect(db?.filters).toEqual([{ kind: "bool", field, value: true }]);
    }
  });

  test("a workspace-only clause SKIPS the half (null) rather than mis-answering it", () => {
    expect(
      toDatabaseQuery(query([{ kind: "term", field: "owner", op: "include", values: ["me"] }]), 25),
    ).toBeNull();
    expect(
      toDatabaseQuery(query([{ kind: "bool", field: "never_contacted", value: true }]), 25),
    ).toBeNull();
    expect(toDatabaseQuery(query([{ kind: "range", field: "score", gte: 50 }]), 25)).toBeNull();
    // One workspace-only clause among shared ones still skips: the answer would be wrong, not partial.
    expect(
      toDatabaseQuery(
        query([
          { kind: "term", field: "title", op: "include", values: ["VP"] },
          { kind: "term", field: "outreach_status", op: "include", values: ["new"] },
        ]),
        25,
      ),
    ).toBeNull();
  });

  test("free text rides along", () => {
    expect(toDatabaseQuery({ ...query([]), text: "jane" }, 10)?.text).toBe("jane");
  });
});

describe("mergeRows — owned first, then the database people the workspace does not hold", () => {
  test("dedupes by slug and drops people the workspace already holds", () => {
    const owned = [ownedContact("held", "00000000-0000-0000-0000-000000000001")];
    const rows = mergeRows(owned, [
      person("held"),
      person("new"),
      person("elsewhere", {
        inWorkspace: { contactId: "00000000-0000-0000-0000-000000000009", isRevealed: false },
      }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["00000000-0000-0000-0000-000000000001", "db:new"]);
    expect(rows[1]?.databaseSlug).toBe("new");
    expect(countDatabaseRows(rows)).toBe(1);
  });

  test("a materialized slug renders as the saved contact IN PLACE, and survives an inWorkspace flip", () => {
    const flipped = ownedRowFromDatabase(
      databasePersonToRow(person("second")),
      "00000000-0000-0000-0000-000000000002",
      { hasEmail: true, hasPhone: true },
      "email",
    );
    const materialized = new Map([["second", flipped]]);
    const before = mergeRows(
      [],
      [person("first"), person("second"), person("third")],
      materialized,
    );
    expect(before.map((r) => r.id)).toEqual([
      "db:first",
      "00000000-0000-0000-0000-000000000002",
      "db:third",
    ]);
    // The database half refetched and now says "in workspace" — the row must not vanish from its place.
    const after = mergeRows(
      [],
      [
        person("first"),
        person("second", {
          inWorkspace: { contactId: "00000000-0000-0000-0000-000000000002", isRevealed: true },
        }),
        person("third"),
      ],
      materialized,
    );
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(countDatabaseRows(after)).toBe(2);
  });

  test("once the owned half returns the slug, the owned copy wins and the in-place copy is dropped", () => {
    const flipped = ownedRowFromDatabase(
      databasePersonToRow(person("second")),
      "00000000-0000-0000-0000-000000000002",
      undefined,
      "email",
    );
    const rows = mergeRows(
      [ownedContact("second", "00000000-0000-0000-0000-000000000002")],
      [person("first"), person("second")],
      new Map([["second", flipped]]),
    );
    expect(rows.map((r) => r.id)).toEqual(["00000000-0000-0000-0000-000000000002", "db:first"]);
  });
});

describe("ownedRowFromDatabase — the row a database person becomes", () => {
  test("real id, no slug marker, presence kept, the reveal marked", () => {
    const row = ownedRowFromDatabase(
      databasePersonToRow(person("jane", { hasPhone: false })),
      "00000000-0000-0000-0000-000000000003",
      { hasEmail: true, hasPhone: true },
      "email",
    );
    expect(row.id).toBe("00000000-0000-0000-0000-000000000003");
    expect((row as { databaseSlug?: string }).databaseSlug).toBeUndefined();
    expect(row.hasPhone).toBe(true); // Layer-0 says there is a phone to reveal — keep offering it
    expect(row.isRevealed).toBe(true);
    expect(row.revealedTypes).toEqual(["email"]);
  });

  test("saved but not revealed (the reveal failed after the landing) is honest about both", () => {
    const row = ownedRowFromDatabase(
      databasePersonToRow(person("jane")),
      "00000000-0000-0000-0000-000000000004",
      undefined,
      undefined,
    );
    expect(row.isRevealed).toBe(false);
    expect(row.revealedTypes).toEqual([]);
    expect(row.hasEmail).toBe(true);
  });
});
