// searchAbort.test.ts — guards the AbortSignal plumbing on the four search calls.
//
// Why: the hooks now cancel a superseded request so the NEWEST query wins. That only works if the signal
// actually reaches fetch — and a signal argument is the kind of thing a later refactor drops silently, because
// nothing fails loudly when it goes missing: the request simply becomes uncancellable and the old
// last-response-wins race quietly returns. These assertions are the tripwire.
//
// `@/lib/authClient` is mock.module'd so no network or auth is involved.

import { describe, expect, mock, test } from "bun:test";
import type { AccountQuery, ContactQuery } from "@leadwolf/types";

const calls: { url: string; init: RequestInit | undefined }[] = [];

mock.module("@/lib/authClient", () => ({
  fetchWithAuth: async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ hits: [], accounts: [], facets: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

const { searchContacts, fetchFacetCounts } = await import("./searchApi.ts");
const { searchAccounts, fetchAccountFacetCounts } = await import("./accountSearchApi.ts");

const contactQuery = { limit: 50 } as unknown as ContactQuery;
const accountQuery = { limit: 50 } as unknown as AccountQuery;

describe("search calls forward the AbortSignal to fetch", () => {
  test("searchContacts", async () => {
    calls.length = 0;
    const c = new AbortController();
    await searchContacts(contactQuery, c.signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.signal).toBe(c.signal);
  });

  test("fetchFacetCounts", async () => {
    calls.length = 0;
    const c = new AbortController();
    // Literal (uncast) so TypeScript verifies these are real facet keys — a cast here would let the test keep
    // passing against a key the API no longer accepts.
    await fetchFacetCounts(contactQuery, ["title"], c.signal);
    expect(calls[0]?.init?.signal).toBe(c.signal);
  });

  test("searchAccounts", async () => {
    calls.length = 0;
    const c = new AbortController();
    await searchAccounts(accountQuery, c.signal);
    expect(calls[0]?.init?.signal).toBe(c.signal);
  });

  test("fetchAccountFacetCounts", async () => {
    calls.length = 0;
    const c = new AbortController();
    await fetchAccountFacetCounts(accountQuery, ["industry"], c.signal);
    expect(calls[0]?.init?.signal).toBe(c.signal);
  });

  test("signal stays optional — omitting it must not send one", async () => {
    calls.length = 0;
    await searchContacts(contactQuery);
    expect(calls[0]?.init?.signal).toBeUndefined();
  });
});
