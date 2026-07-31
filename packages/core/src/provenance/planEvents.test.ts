import { describe, expect, test } from "bun:test";
import { provenanceEventDraftSchema } from "@leadwolf/types";
import { planFieldWrite } from "../prospect/fieldProvenance.ts";
import { type ProvenanceEventContext, planProvenanceEvents } from "./planEvents.ts";

const CONTACT = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";

const overlayContext: ProvenanceEventContext = {
  entityType: "contact",
  entityId: CONTACT,
  scopeRef: WORKSPACE,
  sourceType: "import",
  lawfulBasis: "legitimate_interest",
};

const SOURCE = { src: "import:apollo", mth: "deterministic_email", conf: 0.9 };

describe("planProvenanceEvents", () => {
  test("one draft per written field, and every draft is schema-valid", () => {
    const drafts = planProvenanceEvents({
      context: overlayContext,
      writableFields: ["jobTitle", "department"],
      source: SOURCE,
      values: { jobTitle: "VP Sales", department: "Sales" },
    });
    expect(drafts).toHaveLength(2);
    // Round-tripping through the schema is the real assertion: it proves the drafts satisfy the same rules
    // the database and the API edge enforce, rather than merely having the right shape.
    for (const d of drafts) expect(provenanceEventDraftSchema.safeParse(d).success).toBe(true);
    expect(drafts.map((d) => d.field).sort()).toEqual(["department", "jobTitle"]);
  });

  test("it composes with planFieldWrite — a pinned field is asserted by nobody", () => {
    // The load-bearing composition. A field skipped because a human pinned it was NOT asserted by this source,
    // so recording an event for it would inflate the corroboration count for a value that never won — and
    // corroboration count is the confidence signal and the S-10 badge.
    const existing = { jobTitle: { src: "user_edit", pin: true } };
    const { writableFields } = planFieldWrite(existing, ["jobTitle", "department"], SOURCE);
    const drafts = planProvenanceEvents({
      context: overlayContext,
      writableFields,
      source: SOURCE,
    });
    expect(drafts.map((d) => d.field)).toEqual(["department"]);
  });

  test("no writable fields means no events", () => {
    expect(
      planProvenanceEvents({ context: overlayContext, writableFields: [], source: SOURCE }),
    ).toEqual([]);
  });

  // ── The payload rule (09-compliance rule 3) ───────────────────────────────────────────────────────────────
  test("channel entities reference their value and never carry it", () => {
    const drafts = planProvenanceEvents({
      context: { ...overlayContext, entityType: "email", scopeRef: null },
      writableFields: ["value"],
      source: { src: "reveal" },
      values: { value: "jane@example.com" },
    });
    expect(drafts[0]?.payload).toEqual({});
    // And the schema agrees — belt and braces, not one or the other.
    expect(provenanceEventDraftSchema.safeParse(drafts[0]).success).toBe(true);
  });

  test("non-channel entities do carry the value they asserted", () => {
    const drafts = planProvenanceEvents({
      context: overlayContext,
      writableFields: ["jobTitle"],
      source: SOURCE,
      values: { jobTitle: "VP Sales" },
    });
    expect(drafts[0]?.payload).toEqual({ v: "VP Sales" });
  });

  test("an unknown value yields an empty payload rather than an explicit null", () => {
    // "we did not record the value" and "the value was null" are different claims; conflating them would make
    // a replay of the log assert deletions that never happened.
    const drafts = planProvenanceEvents({
      context: overlayContext,
      writableFields: ["jobTitle"],
      source: SOURCE,
    });
    expect(drafts[0]?.payload).toEqual({});
  });

  // ── Valid time vs transaction time ────────────────────────────────────────────────────────────────────────
  test("observedAt comes from the source, not from now()", () => {
    const drafts = planProvenanceEvents({
      context: overlayContext,
      writableFields: ["jobTitle"],
      source: { ...SOURCE, obs: "2024-01-15T00:00:00.000Z" },
    });
    expect(drafts[0]?.observedAt?.toISOString()).toBe("2024-01-15T00:00:00.000Z");
  });

  test("a missing or unparseable observed time stays null", () => {
    // Defaulting to now() would make a late-arriving old fact look freshly observed — precisely the error the
    // S-09/S-13 decay work depends on not making.
    for (const obs of [undefined, "not-a-date"]) {
      const drafts = planProvenanceEvents({
        context: overlayContext,
        writableFields: ["jobTitle"],
        source: { ...SOURCE, obs },
      });
      expect(drafts[0]?.observedAt).toBeNull();
    }
  });

  // ── Context passthrough ───────────────────────────────────────────────────────────────────────────────────
  test("a pending acceptance state propagates to every draft", () => {
    const drafts = planProvenanceEvents({
      context: { ...overlayContext, sourceType: "extension", acceptanceState: "pending" },
      writableFields: ["jobTitle", "department"],
      source: { src: "extension" },
    });
    expect(drafts.every((d) => d.acceptanceState === "pending")).toBe(true);
  });

  test("a Layer-0 draft carries no workspace hint and still validates", () => {
    const drafts = planProvenanceEvents({
      context: {
        entityType: "person",
        entityId: "11111111-1111-4111-8111-111111111111",
        sourceType: "provider",
        lawfulBasis: "legitimate_interest",
      },
      writableFields: ["jobTitle"],
      source: SOURCE,
    });
    expect(drafts[0]?.scopeRef).toBeNull();
    expect(provenanceEventDraftSchema.safeParse(drafts[0]).success).toBe(true);
  });

  test("the action defaults to assert and is overridable", () => {
    const base = { context: overlayContext, writableFields: ["jobTitle"], source: SOURCE };
    expect(planProvenanceEvents(base)[0]?.action).toBe("assert");
    expect(planProvenanceEvents({ ...base, action: "pin" })[0]?.action).toBe("pin");
  });
});
