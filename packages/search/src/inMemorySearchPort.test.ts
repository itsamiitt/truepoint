// inMemorySearchPort.test.ts — end-to-end proof of the SearchPort contract on the dev adapter: a "CEO"
// title filter matches a row stored as "Chief Executive Officer", suggest pulls values from the data,
// facet counts group by canonical occupation, and workspace isolation + keyset paging hold (24 §3–§6).

import { describe, expect, test } from "bun:test";
import type { ContactQuery, IndexedContact, SearchCtx } from "./index.ts";
import { createInMemorySearchPort } from "./inMemorySearchPort.ts";

const WS = "ws-1";
const ctx: SearchCtx = { workspaceId: WS };

function contact(over: Partial<IndexedContact> & { id: string }): IndexedContact {
  return {
    workspaceId: WS,
    firstName: "A",
    lastName: "Person",
    jobTitle: null,
    emailDomain: "acme.com",
    emailStatus: "unverified",
    hasEmail: true,
    hasPhone: false,
    seniorityLevel: null,
    department: null,
    locationCountry: null,
    locationCity: null,
    outreachStatus: "new",
    isRevealed: false,
    ownerUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function query(over: Partial<ContactQuery> = {}): ContactQuery {
  return { filters: [], sort: "relevance", limit: 50, ...over };
}

const seed: IndexedContact[] = [
  contact({ id: "1", jobTitle: "Chief Executive Officer", seniorityLevel: "c_suite", createdAt: "2026-01-05T00:00:00.000Z" }),
  contact({ id: "2", jobTitle: "CEO", seniorityLevel: "c_suite", createdAt: "2026-01-04T00:00:00.000Z" }),
  contact({ id: "3", jobTitle: "Software Engineer", seniorityLevel: "ic", createdAt: "2026-01-03T00:00:00.000Z" }),
  contact({ id: "4", jobTitle: "Chief Executive Officer", seniorityLevel: "c_suite", workspaceId: "ws-2" }),
];

describe("inMemorySearchPort.searchContacts", () => {
  test("a 'CEO' title filter matches rows stored as 'Chief Executive Officer'", async () => {
    const port = createInMemorySearchPort(seed);
    const page = await port.searchContacts(
      query({ filters: [{ kind: "term", field: "title", op: "include", values: ["CEO"] }] }),
      ctx,
    );
    expect(page.hits.map((h) => h.id).sort()).toEqual(["1", "2"]);
  });

  test("workspace isolation: ws-2's CEO never appears for ws-1", async () => {
    const port = createInMemorySearchPort(seed);
    const page = await port.searchContacts(
      query({ filters: [{ kind: "term", field: "title", op: "include", values: ["Chief Executive Officer"] }] }),
      ctx,
    );
    expect(page.hits.every((h) => h.id !== "4")).toBe(true);
  });

  test("exclude op removes the matching rows", async () => {
    const port = createInMemorySearchPort(seed);
    const page = await port.searchContacts(
      query({ filters: [{ kind: "term", field: "title", op: "exclude", values: ["CEO"] }] }),
      ctx,
    );
    expect(page.hits.map((h) => h.id)).toEqual(["3"]);
  });

  test("free-text search matches the job title substring", async () => {
    const port = createInMemorySearchPort(seed);
    const page = await port.searchContacts(query({ text: "software" }), ctx);
    expect(page.hits.map((h) => h.id)).toEqual(["3"]);
  });

  test("keyset pagination walks all rows without overlap", async () => {
    const port = createInMemorySearchPort(seed);
    const first = await port.searchContacts(query({ limit: 2 }), ctx);
    expect(first.hits.map((h) => h.id)).toEqual(["1", "2"]);
    expect(first.nextCursor).toBe("2");
    const second = await port.searchContacts(query({ limit: 2, cursor: first.nextCursor ?? undefined }), ctx);
    expect(second.hits.map((h) => h.id)).toEqual(["3"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("inMemorySearchPort.suggest", () => {
  test("typing 'ceo' suggests 'Chief Executive Officer' with its canonical id and count", async () => {
    const port = createInMemorySearchPort(seed);
    const out = await port.suggest({ field: "title", prefix: "ceo", limit: 10, scope: "workspace" }, ctx);
    const ceo = out.find((s) => s.canonicalId === "chief_executive_officer");
    expect(ceo).toBeDefined();
    expect(ceo?.displayLabel).toBe("Chief Executive Officer");
    expect(ceo?.count).toBe(2); // rows 1 + 2 collapse to one canonical occupation
  });

  test("typing 'soft' suggests Software Engineer", async () => {
    const port = createInMemorySearchPort(seed);
    const out = await port.suggest({ field: "title", prefix: "soft", limit: 10, scope: "workspace" }, ctx);
    expect(out.some((s) => s.canonicalId === "software_engineer")).toBe(true);
  });
});

describe("inMemorySearchPort.facetCounts", () => {
  test("counts group by canonical occupation, scoped to the workspace", async () => {
    const port = createInMemorySearchPort(seed);
    const counts = await port.facetCounts(query(), ["title"], ctx);
    const ceo = counts.find((c) => c.value === "chief_executive_officer");
    expect(ceo?.count).toBe(2);
    const swe = counts.find((c) => c.value === "software_engineer");
    expect(swe?.count).toBe(1);
  });
});
