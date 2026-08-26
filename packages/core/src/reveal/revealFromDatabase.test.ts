// revealFromDatabase.test.ts — the ORDER of reveal-as-save [S-06][S-04]: the kill switch refuses before any
// write; a person the graph does not hold is a 404 and never a half-saved contact; exactly one materialization
// precedes exactly one reveal (one gesture, one request — the S-06 metric); and a reveal that fails AFTER the
// landing still tells the caller the person is saved, so the row can flip honestly. Deps are injected — no
// database, no mock.module.
import { describe, expect, test } from "bun:test";
import {
  DatabaseRevealDisabledError,
  InsufficientCreditsError,
  NotFoundError,
  type RevealResponse,
  ValidationError,
} from "@leadwolf/types";
import { type RevealFromDatabaseDeps, revealFromDatabase } from "./revealFromDatabase.ts";

const CONTACT = "33333333-3333-3333-3333-333333333333";
const scope = { tenantId: "t", workspaceId: "w" };
const input = {
  scope,
  userId: "u",
  by: { linkedinPublicId: "jane-doe" },
  revealType: "email" as const,
};

const revealResponse = (contactId: string): RevealResponse => ({
  contactId,
  reveal_type: "email",
  email: "jane@example.com",
  creditsCharged: 1,
  balanceAfter: 9,
  alreadyOwned: false,
  missingFields: [],
  nothingToReveal: false,
});

/** Fake deps that record the call order. */
function harness(overrides: Partial<RevealFromDatabaseDeps> = {}) {
  const calls: string[] = [];
  const revealInputs: Parameters<RevealFromDatabaseDeps["reveal"]>[0][] = [];
  const deps: RevealFromDatabaseDeps = {
    gateOn: () => true,
    materialize: async () => {
      calls.push("materialize");
      return {
        outcome: "created",
        contactId: CONTACT,
        presence: { hasEmail: true, hasPhone: false },
      };
    },
    reveal: async (revealInput) => {
      calls.push("reveal");
      revealInputs.push(revealInput);
      return revealResponse(revealInput.contactId);
    },
    ...overrides,
  };
  return { deps, calls, revealInputs };
}

/** Explicit try/catch (house rule: never `expect(...).rejects` on anything that could hold a connection). */
async function capture(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("revealFromDatabase — one gesture, in the honest order", () => {
  test("the kill switch refuses BEFORE any write", async () => {
    const h = harness({ gateOn: () => false });
    const err = await capture(() => revealFromDatabase(input, h.deps));
    expect(err).toBeInstanceOf(DatabaseRevealDisabledError);
    expect((err as DatabaseRevealDisabledError).code).toBe("database_reveal_disabled");
    expect(h.calls).toEqual([]);
  });

  test("exactly one materialization, then exactly one reveal, on the contact that landed", async () => {
    const h = harness();
    const result = await revealFromDatabase(input, h.deps);
    expect(h.calls).toEqual(["materialize", "reveal"]);
    expect(result.contactId).toBe(CONTACT);
    expect(result.outcome).toBe("created");
    expect(result.presence).toEqual({ hasEmail: true, hasPhone: false });
    expect(result.reveal.contactId).toBe(CONTACT);
    // The reveal is addressed by the landed contact and carries the caller's identity + the asked-for type.
    expect(h.revealInputs[0]).toMatchObject({
      scope,
      userId: "u",
      contactId: CONTACT,
      revealType: "email",
    });
  });

  test("a re-save of a person the workspace already holds is `known`, and still reveals once", async () => {
    const h = harness({
      materialize: async () => ({
        outcome: "known",
        contactId: CONTACT,
        presence: { hasEmail: true, hasPhone: true },
      }),
    });
    const result = await revealFromDatabase(input, h.deps);
    expect(result.outcome).toBe("known");
    expect(h.calls).toEqual(["reveal"]);
  });

  test("a person the graph does not hold is 404 — and nothing is revealed", async () => {
    const h = harness({
      materialize: async () => ({ outcome: "skipped", contactId: null, reason: "not_in_database" }),
    });
    const err = await capture(() => revealFromDatabase(input, h.deps));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(h.calls).toEqual([]);
  });

  test("an address that is not a person URL is a validation error, not a 404", async () => {
    const h = harness({
      materialize: async () => ({ outcome: "skipped", contactId: null, reason: "not_supported" }),
    });
    const err = await capture(() =>
      revealFromDatabase(
        { ...input, by: { url: "https://www.linkedin.com/company/acme" } },
        h.deps,
      ),
    );
    expect(err).toBeInstanceOf(ValidationError);
  });

  test("a reveal that fails after the landing keeps its class and says the person is saved", async () => {
    const h = harness({
      reveal: async () => {
        throw new InsufficientCreditsError(0, 1);
      },
    });
    const err = await capture(() => revealFromDatabase(input, h.deps));
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect((err as InsufficientCreditsError).status).toBe(402);
    expect((err as InsufficientCreditsError).extensions).toMatchObject({
      contactId: CONTACT,
      outcome: "created",
    });
  });
});
