// resolver.test.ts — pins the PII-free payload → (subjectKey, url) reconstruction the SSE consumer relies on.
// The reconstruction must mirror the content-script adapter's subjectKey (a public slug is the key; a Sales-Nav
// lead is `sales-lead:<id>`) or a push would broadcast a status the hover card / panel can't match to its row.
import { describe, expect, test } from "bun:test";
import { intelCache } from "./intel.ts";
import { lookupCache, refreshSubjectFromEvent, subjectFromLookupEvent } from "./resolver.ts";

describe("subjectFromLookupEvent", () => {
  test("public slug → /in/ url + bare-slug subjectKey", () => {
    expect(subjectFromLookupEvent({ linkedinPublicId: "jane-doe", outcome: "landed" })).toEqual({
      subjectKey: "jane-doe",
      sourceUrl: "https://www.linkedin.com/in/jane-doe",
    });
  });

  test("sales-nav lead → /sales/lead/ url + sales-lead: subjectKey", () => {
    expect(subjectFromLookupEvent({ salesNavLeadId: "ACwAAB", outcome: "refreshed" })).toEqual({
      subjectKey: "sales-lead:ACwAAB",
      sourceUrl: "https://www.linkedin.com/sales/lead/ACwAAB",
    });
  });

  test("slug wins when both present (public id is the stronger key)", () => {
    expect(
      subjectFromLookupEvent({ linkedinPublicId: "jane", salesNavLeadId: "X", outcome: "landed" }),
    ).toEqual({ subjectKey: "jane", sourceUrl: "https://www.linkedin.com/in/jane" });
  });

  test("null when neither addressing key is a non-empty string", () => {
    expect(subjectFromLookupEvent({ outcome: "landed" })).toBeNull();
    expect(subjectFromLookupEvent({ linkedinPublicId: "" })).toBeNull();
    expect(subjectFromLookupEvent({ linkedinPublicId: 123 })).toBeNull();
  });
});

// ── The push must invalidate BOTH caches ────────────────────────────────────────────────────────────────
// A `contact.lookup_updated` push means the server landed new data for a subject the user is looking at.
// Invalidating only the LOOKUP cache half-lands it: the hover card shows the fresh status while the panel
// keeps serving its (much longer-lived) intel entry for the same person. A partial invalidation is worse
// than none — it looks correct while being stale, on the surface that is actually reading the landed data.
describe("refreshSubjectFromEvent — cache invalidation", () => {
  test("drops the subject from the lookup cache AND the intel cache", async () => {
    const key = "jane-visible";
    const stale = { contactId: null, known: false, owned: false, outcome: "not_found" } as never;
    const fresh = { contactId: "c-1", known: true, owned: false, outcome: "found" } as never;

    // Warm both caches for one subject, as a panel + hover card viewing that person would.
    await lookupCache.resolve(key, async () => stale);
    await intelCache.resolve(key, async () => ({ fetchedAt: 1 }) as never);

    let resolved = 0;
    const ctx = {
      api: {
        lookupByUrl: async () => {
          resolved += 1;
          return fresh;
        },
      },
    } as never;

    const out = await refreshSubjectFromEvent(ctx, { linkedinPublicId: key });

    // It re-resolved rather than returning the warm (stale) status.
    expect(resolved).toBe(1);
    expect(out?.status).toEqual(fresh);

    // …and the INTEL entry is gone too, so the panel's next read reaches the server.
    let intelFetches = 0;
    await intelCache.resolve(key, async () => {
      intelFetches += 1;
      return { fetchedAt: 2 } as never;
    });
    expect(intelFetches).toBe(1);

    lookupCache.clear();
    intelCache.clear();
  });
});
