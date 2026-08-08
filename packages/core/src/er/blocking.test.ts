// blocking.test.ts — the candidate generator's keys.
//
// The load-bearing cases are the ones that decide whether the probabilistic tier is safe to switch on:
//   • records that cannot be keyed get NULL, never a shared bucket (the quadratic bomb);
//   • cross-source spelling drift lands in the SAME block (a pair never blocked is never compared);
//   • the block budget counts COMPARISONS, not records.
//
// Scoring is NOT tested here — fellegiSunter.test.ts owns that, and this module deliberately does not
// re-implement it.

import { describe, expect, test } from "bun:test";
import {
  blockBudget,
  companyBlockKey,
  foldToken,
  personBlockKey,
  technologyBlockKey,
} from "./blocking.ts";

describe("foldToken", () => {
  test("strips diacritics so cross-source spelling drift agrees", () => {
    expect(foldToken("Müller")).toBe(foldToken("Muller"));
    expect(foldToken("Ångström")).toBe(foldToken("Angstrom"));
    expect(foldToken("Renée")).toBe(foldToken("Renee"));
  });

  test("drops punctuation, spacing and case", () => {
    expect(foldToken("O'Brien-Smith Jr.")).toBe("obriensmithjr");
  });

  test("keeps digits", () => {
    expect(foldToken("Route 66")).toBe("route66");
  });

  test("an unfoldable string folds to empty rather than throwing", () => {
    expect(foldToken("—··—")).toBe("");
    expect(foldToken("")).toBe("");
  });
});

describe("personBlockKey", () => {
  test("surname + first initial + country", () => {
    expect(personBlockKey({ lastName: "Smith", firstName: "Jane", countryCode: "GB" })).toBe(
      "p:smith:j:gb",
    );
  });

  // Why the INITIAL rather than the whole forename: truncations are one person written two ways, and a
  // full-forename key would split them into blocks that never meet.
  test("truncated forenames share a block", () => {
    expect(personBlockKey({ lastName: "Jones", firstName: "Rob", countryCode: "US" })).toBe(
      personBlockKey({ lastName: "Jones", firstName: "Robert", countryCode: "US" }) as string,
    );
    expect(personBlockKey({ lastName: "Ng", firstName: "Kate", countryCode: "SG" })).toBe(
      personBlockKey({ lastName: "Ng", firstName: "Katherine", countryCode: "SG" }) as string,
    );
  });

  // KNOWN LIMITATION, asserted so it is a documented property rather than a surprise. A SUBSTITUTED nickname
  // has a different initial, so the probabilistic tier never compares the pair. Closing it needs a nickname
  // lookup table; the deterministic tier still resolves these, and resolves most of them.
  test("substituted nicknames do NOT share a block — Bob/Robert, Bill/William", () => {
    expect(personBlockKey({ lastName: "Jones", firstName: "Bob", countryCode: "US" })).not.toBe(
      personBlockKey({ lastName: "Jones", firstName: "Robert", countryCode: "US" }),
    );
    expect(personBlockKey({ lastName: "Gates", firstName: "Bill", countryCode: "US" })).not.toBe(
      personBlockKey({ lastName: "Gates", firstName: "William", countryCode: "US" }),
    );
  });

  test("accented and unaccented surnames share a block", () => {
    expect(personBlockKey({ lastName: "Müller", firstName: "Anna", countryCode: "DE" })).toBe(
      personBlockKey({ lastName: "Muller", firstName: "Anna", countryCode: "DE" }) as string,
    );
  });

  test("different surnames do not collide", () => {
    expect(personBlockKey({ lastName: "Smith", firstName: "J" })).not.toBe(
      personBlockKey({ lastName: "Smyth", firstName: "J" }),
    );
  });

  // THE quadratic-bomb guard.
  test("returns null without a usable surname", () => {
    expect(personBlockKey({ lastName: "", firstName: "Jane" })).toBeNull();
    expect(personBlockKey({ lastName: null, firstName: "Jane" })).toBeNull();
    expect(personBlockKey({ lastName: "X", firstName: "Jane" })).toBeNull();
    expect(personBlockKey({})).toBeNull();
  });

  test("missing forename or country still yields a key, with placeholders", () => {
    expect(personBlockKey({ lastName: "Smith" })).toBe("p:smith:_:__");
  });
});

describe("companyBlockKey", () => {
  test("strips trailing legal suffixes so Ltd and Limited agree", () => {
    expect(companyBlockKey({ name: "Acme Ltd", countryCode: "GB" })).toBe(
      companyBlockKey({ name: "Acme Limited", countryCode: "GB" }) as string,
    );
    expect(companyBlockKey({ name: "Contoso Inc.", countryCode: "US" })).toBe(
      companyBlockKey({ name: "Contoso Incorporated", countryCode: "US" }) as string,
    );
  });

  test("strips a trailing Group but keeps a leading one", () => {
    expect(companyBlockKey({ name: "Acme Group", countryCode: "GB" })).toBe("c:acme:gb");
    expect(companyBlockKey({ name: "Group4 Securities", countryCode: "GB" })).toBe(
      "c:group4securities:gb",
    );
  });

  test("country separates same-named companies", () => {
    expect(companyBlockKey({ name: "Acme", countryCode: "US" })).not.toBe(
      companyBlockKey({ name: "Acme", countryCode: "DE" }),
    );
  });

  test("returns null when there is nothing left to key on", () => {
    expect(companyBlockKey({ name: "", countryCode: "GB" })).toBeNull();
    expect(companyBlockKey({ name: "—", countryCode: "GB" })).toBeNull();
    expect(companyBlockKey({ name: "Co", countryCode: "GB" })).toBeNull();
    expect(companyBlockKey({})).toBeNull();
  });

  // "Never strip the only remaining word" wins over suffix-stripping: a junk block beats an empty key.
  test("never strips the only remaining word", () => {
    expect(companyBlockKey({ name: "Holdings", countryCode: "GB" })).toBe("c:holdings:gb");
    expect(companyBlockKey({ name: "Ltd", countryCode: "GB" })).toBe("c:ltd:gb");
  });
});

describe("technologyBlockKey", () => {
  test("folds the canonical name and omits country", () => {
    expect(technologyBlockKey({ canonicalName: "Amazon S3" })).toBe("t:amazons3");
  });

  test("returns null when there is nothing to key on", () => {
    expect(technologyBlockKey({ canonicalName: "" })).toBeNull();
    expect(technologyBlockKey({})).toBeNull();
  });
});

describe("blockBudget", () => {
  test("counts comparisons, not records", () => {
    expect(blockBudget(100).comparisons).toBe(4950);
  });

  test("admits a block within budget", () => {
    expect(blockBudget(200).admit).toBe(true);
  });

  // A block that merely looks large is quadratically expensive.
  test("refuses a block whose comparison count blows the budget", () => {
    const b = blockBudget(1000);
    expect(b.comparisons).toBe(499_500);
    expect(b.admit).toBe(false);
  });

  test("trivial blocks are free, and report +0 rather than -0", () => {
    expect(blockBudget(1)).toEqual({ admit: true, comparisons: 0 });
    expect(blockBudget(0)).toEqual({ admit: true, comparisons: 0 });
  });

  test("the budget is configurable", () => {
    expect(blockBudget(1000, 1_000_000).admit).toBe(true);
  });
});
