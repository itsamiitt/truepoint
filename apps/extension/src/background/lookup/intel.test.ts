// intel.test.ts — the panel's read path in the service worker. Pure: a hand-rolled RuntimeContext, no chrome,
// no network.
//
// The three behaviours that cost real money or real trust if they regress:
//   1. COALESCING. The panel re-asks on mount, on navigation and on tab switch; those arrive together. Two
//      concurrent INTELs for one subject must be ONE request (test 1).
//   2. THE NO-CHARGE HYDRATE. A contact this workspace already owns is re-rendered from
//      GET /contacts/:id/revealed (ADR-0042) — never by revealing again. Test 3 pins that the reveal path is
//      not touched, and test 4 that an unowned contact is not even asked about.
//   3. FAILURES ARE NOT CACHED. A blip must not stick for the whole five-minute window (test 5).

import { beforeEach, describe, expect, it } from "bun:test";
import type { ProfileIntelResponse, RevealedContact } from "@leadwolf/types";
import type { RuntimeContext } from "../context.ts";
import { intelCache, resolveIntel } from "./intel.ts";

const INTEL: ProfileIntelResponse = {
  kind: "person",
  status: "found",
  contactId: "c-1",
  owned: false,
  person: null,
  contact: null,
  profile: null,
  company: null,
  signals: [],
};

const REVEALED = { contactId: "c-1", email: "x@example.test" } as unknown as RevealedContact;

interface Calls {
  lookupIntel: string[];
  revealed: string[];
  viewFetch: Array<{ kind: string; url: string }>;
  reveal: number;
  creditsRefresh: number;
}

let calls: Calls;
let intelResult: ProfileIntelResponse | Error = INTEL;

function ctx(): RuntimeContext {
  return {
    api: {
      lookupIntel: async (url: string) => {
        calls.lookupIntel.push(url);
        if (intelResult instanceof Error) throw intelResult;
        return intelResult;
      },
      revealedContact: async (id: string) => {
        calls.revealed.push(id);
        return REVEALED;
      },
      viewFetch: async (kind: string, url: string) => {
        calls.viewFetch.push({ kind, url });
        return { outcome: "fresh", contactId: null };
      },
      reveal: async () => {
        calls.reveal += 1;
        return {};
      },
    },
    credits: {
      costs: { email: 1, phone: 2, full_profile: 3 },
      refresh: async () => {
        calls.creditsRefresh += 1;
      },
    },
    telemetry: { event: async () => {}, error: async () => {} },
  } as unknown as RuntimeContext;
}

beforeEach(() => {
  calls = { lookupIntel: [], revealed: [], viewFetch: [], reveal: 0, creditsRefresh: 0 };
  intelResult = INTEL;
  intelCache.clear();
});

describe("resolveIntel", () => {
  it("1. coalesces concurrent reads for the same subject into one request", async () => {
    // The mount + the SUBJECT_VIEWED broadcast + a tab switch can all fire within a frame of each other.
    // A gated fetcher makes the overlap deterministic instead of timing-dependent.
    let unblock!: () => void;
    const gate = new Promise<void>((r) => {
      unblock = r;
    });
    const c = ctx();
    (
      c.api as unknown as { lookupIntel: (u: string) => Promise<ProfileIntelResponse> }
    ).lookupIntel = async (url: string) => {
      calls.lookupIntel.push(url);
      await gate;
      return INTEL;
    };

    const both = Promise.all([
      resolveIntel(c, "jane-doe", "https://www.linkedin.com/in/jane-doe"),
      resolveIntel(c, "jane-doe", "https://www.linkedin.com/in/jane-doe"),
    ]);
    unblock();
    const [a, b] = await both;

    expect(calls.lookupIntel).toHaveLength(1);
    expect(a.intel).toEqual(b.intel);
  });

  it("2. serves the warm cache on a repeat read, and force bypasses it", async () => {
    const c = ctx();
    await resolveIntel(c, "jane-doe", "https://www.linkedin.com/in/jane-doe");
    await resolveIntel(c, "jane-doe", "https://www.linkedin.com/in/jane-doe");
    expect(calls.lookupIntel).toHaveLength(1);

    // Re-capture: drop the entry AND ask the source to refresh first (the 30-day clock makes a repeat click
    // free of vendor cost server-side).
    await resolveIntel(c, "jane-doe", "https://www.linkedin.com/in/jane-doe", { force: true });
    expect(calls.lookupIntel).toHaveLength(2);
    expect(calls.viewFetch).toEqual([
      { kind: "person", url: "https://www.linkedin.com/in/jane-doe" },
    ]);
  });

  it("3. hydrates an OWNED contact from the no-charge revealed read, never from reveal", async () => {
    intelResult = { ...INTEL, owned: true, contactId: "c-1" };
    const c = ctx();

    const payload = await resolveIntel(c, "jane-doe", "https://www.linkedin.com/in/jane-doe");

    expect(calls.revealed).toEqual(["c-1"]);
    expect(calls.reveal).toBe(0); // re-rendering an owned card must never spend a credit
    expect(payload.revealed).toEqual(REVEALED);
    // Prices ride along so the buttons can label themselves without hardcoding a number.
    expect(payload.costs).toEqual({ email: 1, phone: 2, full_profile: 3 });
  });

  it("4. does not ask for revealed values on a contact the workspace does not own", async () => {
    intelResult = { ...INTEL, owned: false, contactId: "c-1" };
    const c = ctx();

    const payload = await resolveIntel(c, "jane-doe", "https://www.linkedin.com/in/jane-doe");

    expect(calls.revealed).toEqual([]);
    expect(payload.revealed).toBeNull();
  });

  it("5. never caches a failure — the next read retries", async () => {
    intelResult = new Error("offline");
    const c = ctx();

    await expect(
      resolveIntel(c, "jane-doe", "https://www.linkedin.com/in/jane-doe"),
    ).rejects.toThrow("offline");

    intelResult = INTEL;
    const ok = await resolveIntel(c, "jane-doe", "https://www.linkedin.com/in/jane-doe");
    expect(ok.intel.status).toBe("found");
    expect(calls.lookupIntel).toHaveLength(2);
  });

  it("6. a company subject refreshes as a company, not a person", async () => {
    const c = ctx();
    await resolveIntel(c, "company:rillet", "https://www.linkedin.com/company/rillet", {
      force: true,
      entityKind: "company",
    });
    expect(calls.viewFetch).toEqual([
      { kind: "company", url: "https://www.linkedin.com/company/rillet" },
    ]);
  });
});
