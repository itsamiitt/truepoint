// delta.test.ts — P5 delta-import PURE units (import-and-data-model-redesign 08 §9 layer 3). The dedup-rung
// behaviour + gate wiring are DB-bound (importDelta.itest.ts); these are the pure legs: the auto-map alias for
// the external key (specific aliases only — never a bare "id") and prepareContact deriving/normalizing it.

import { describe, expect, test } from "bun:test";
import { suggestColumnMapping } from "./headerAliases.ts";
import { prepareContact } from "./prepareContact.ts";

describe("auto-map — externalId (08 §9 layer 3)", () => {
  test("maps the specific external-key aliases", () => {
    expect(suggestColumnMapping(["External Id", "Email"])).toEqual({
      externalId: "External Id",
      email: "Email",
    });
    expect(suggestColumnMapping(["CRM ID"])).toEqual({ externalId: "CRM ID" });
    expect(suggestColumnMapping(["Record Id"])).toEqual({ externalId: "Record Id" });
  });

  test("NEVER auto-claims a bare 'id' column (would silently change dedup precedence gate-on)", () => {
    // A plain "Id"/"ID" header normalizes to "id" — not in the externalId alias list — so it stays UNMAPPED.
    expect(suggestColumnMapping(["Id"])).toEqual({});
    expect(suggestColumnMapping(["ID", "Email"])).toEqual({ email: "Email" });
  });
});

describe("prepareContact — externalId derivation", () => {
  test("derives + normalizes the mapped external key", () => {
    const prepared = prepareContact({ email: "a@x.com", externalId: "  EXT-1  " });
    expect(prepared.externalId).toBe("EXT-1"); // trimmed by normalizeText
  });

  test("absent when unmapped/blank (so the rung + write stay inert)", () => {
    expect(prepareContact({ email: "a@x.com" }).externalId).toBeUndefined();
    expect(prepareContact({ email: "a@x.com", externalId: "   " }).externalId).toBeUndefined();
  });
});
