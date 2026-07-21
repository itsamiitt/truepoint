// headerAliases.test.ts — the S-I8 auto-map proposal's contract (08 §3.2; T11's "auto-map is
// deterministic" leg): binary alias matching over normalized headers, each header consumed once with
// identity-field precedence, and the duplicate-header refusal (two columns collapsing to one key are
// NEVER guessed between — both stay unmapped, 08 §Edge cases). Pure unit — no IO.

import { describe, expect, test } from "bun:test";
import { normalizeHeaderKey, suggestColumnMapping } from "./headerAliases.ts";

describe("normalizeHeaderKey", () => {
  test("collapses case, punctuation, and whitespace to one key", () => {
    for (const h of ["First Name", "first_name", "FIRSTNAME", " First-Name ", "first.name"]) {
      expect(normalizeHeaderKey(h)).toBe("firstname");
    }
  });

  test("a symbol-only header collapses to the empty key (never matches)", () => {
    expect(normalizeHeaderKey("¯\\_(ツ)_/¯")).toBe("");
  });
});

describe("suggestColumnMapping (08 §3.2 — binary, deterministic, no confidence)", () => {
  test("maps the common vendor headers through the alias table", () => {
    const proposal = suggestColumnMapping([
      "First Name",
      "Last Name",
      "E-mail", // alias: "e-mail" normalizes to "email"
      "Company", // alias for accountName
      "Website", // alias for accountDomain
      "Job Title",
      "Mobile Phone",
      "LinkedIn URL",
      "City",
      "Country",
    ]);
    expect(proposal).toEqual({
      email: "E-mail",
      linkedinUrl: "LinkedIn URL",
      firstName: "First Name",
      lastName: "Last Name",
      jobTitle: "Job Title",
      phone: "Mobile Phone",
      locationCity: "City",
      locationCountry: "Country",
      accountName: "Company",
      accountDomain: "Website",
    });
  });

  test("is deterministic: same headers (any invocation) → the same proposal", () => {
    const headers = ["Email Address", "Company Name", "Title", "Surname"];
    expect(suggestColumnMapping(headers)).toEqual(suggestColumnMapping(headers));
    expect(suggestColumnMapping(headers)).toEqual({
      email: "Email Address",
      lastName: "Surname",
      jobTitle: "Title",
      accountName: "Company Name",
    });
  });

  test("duplicate headers are refused, never guessed between (08 §Edge cases)", () => {
    // Two distinct columns both normalize to "email" — auto-map must leave BOTH unmapped.
    const proposal = suggestColumnMapping(["Email", "E-Mail", "First Name"]);
    expect(proposal.email).toBeUndefined();
    expect(proposal.firstName).toBe("First Name");
    // Two byte-identical headers are equally ambiguous (mapRow addresses by header string).
    expect(suggestColumnMapping(["Phone", "Phone"]).phone).toBeUndefined();
  });

  test("each header is consumed once, identity fields claiming first", () => {
    // "Email" satisfies only the email field; a later field never re-claims a used header.
    const proposal = suggestColumnMapping(["Email"]);
    expect(proposal).toEqual({ email: "Email" });
  });

  test("unknown headers stay unmapped (binary — no fuzzy fallback)", () => {
    expect(suggestColumnMapping(["Favourite Colour", "zzz_custom_7"])).toEqual({});
  });
});
