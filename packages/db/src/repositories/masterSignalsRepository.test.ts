// masterSignalsRepository.test.ts — the PII guard on master_signals.payload.
//
// 04-validation.md Part 3 requires that a signal payload never carries contact values, and says explicitly
// that the rule "needs an itest, not a comment". This is the unit half of that: the guard is a pure function,
// so it can be proven without Postgres, and the itest then only has to show the repository calls it.
//
// FALSE POSITIVES ARE THE REAL RISK. A guard that rejects a legitimate funding amount or an evidence URL gets
// switched off by the first engineer it blocks, and then it protects nothing. Roughly half the cases below
// exist to prove the guard stays out of the way of normal signal payloads.

import { describe, expect, test } from "bun:test";
import { assertNoContactValues, findContactValues } from "./masterSignalsRepository.ts";

describe("findContactValues — catches what must never be stored", () => {
  test("an email value anywhere in the payload", () => {
    const v = findContactValues({ note: "reach them at jane.doe@acme.com" });
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toBe("email_value");
  });

  test("an E.164 phone value", () => {
    const v = findContactValues({ note: "+14155550123" });
    expect(v[0]?.reason).toBe("phone_value");
  });

  test("a phone written with separators is still caught", () => {
    expect(findContactValues({ x: "+1 (415) 555-0123" })[0]?.reason).toBe("phone_value");
  });

  // The key alone is disqualifying: an empty `contact_email` field is a schema heading in the wrong
  // direction, and catching it before any value arrives is the cheap moment to catch it.
  test("a forbidden key, even with an empty value", () => {
    const v = findContactValues({ new_employer_email: "" });
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toBe("forbidden_key");
    expect(v[0]?.path).toBe("payload.new_employer_email");
  });

  test("forbidden keys are matched past casing and separators", () => {
    for (const key of ["Email", "e_mail", "phoneNumber", "MOBILE", "direct-dial", "Tel"]) {
      expect(findContactValues({ [key]: "x" })).toHaveLength(1);
    }
  });

  test("nested objects are searched", () => {
    const v = findContactValues({ exec: { profile: { contact: "a@b.co" } } });
    expect(v[0]?.path).toBe("payload.exec.profile.contact");
  });

  test("arrays are searched, and the index is reported", () => {
    const v = findContactValues({ people: [{ note: "ok" }, { note: "x@y.io" }] });
    expect(v[0]?.path).toBe("payload.people[1].note");
  });

  test("every violation is reported, not just the first", () => {
    expect(findContactValues({ a: "x@y.io", b: "+14155550123", c_email: "z" })).toHaveLength(3);
  });

  // A forbidden key stops the descent — reporting the child too would be duplicate noise for one mistake.
  test("a forbidden key reports once, not once per nested value", () => {
    expect(findContactValues({ email: { work: "a@b.co", home: "c@d.co" } })).toHaveLength(1);
  });
});

describe("findContactValues — stays out of the way of legitimate payloads", () => {
  test("a funding amount in minor units is not a phone number", () => {
    expect(findContactValues({ amount_minor: 5_000_000_000, currency: "USD" })).toEqual([]);
  });

  test("a long digit string without a leading + is not a phone number", () => {
    expect(findContactValues({ headcount: "10000000000" })).toEqual([]);
  });

  test("an evidence URL passes", () => {
    expect(
      findContactValues({ evidence: "https://example.com/press/2026/series-b?ref=feed" }),
    ).toEqual([]);
  });

  test("a realistic funding signal passes", () => {
    expect(
      findContactValues({
        round: "series_b",
        lead_investor: "Acme Ventures",
        announced_on: "2026-08-01",
        amount_minor: 25_000_000_00,
      }),
    ).toEqual([]);
  });

  test("a realistic leadership signal referencing a person BY ID passes", () => {
    expect(
      findContactValues({
        person_id: "0199f0d2-1c4e-7a11-9f3a-2b6c8d4e5f60",
        from_company_id: "0199f0d2-1c4e-7a11-9f3a-2b6c8d4e5f61",
        title: "Chief Revenue Officer",
      }),
    ).toEqual([]);
  });

  test("a headline naming a company is not an email", () => {
    expect(findContactValues("Acme Corp acquired Contoso Ltd")).toEqual([]);
  });

  test("empty and null-ish payloads pass", () => {
    expect(findContactValues({})).toEqual([]);
    expect(findContactValues(null)).toEqual([]);
    expect(findContactValues(undefined)).toEqual([]);
  });

  test("numbers, booleans and dates are ignored", () => {
    expect(findContactValues({ n: 42, b: true, d: "2026-08-08T00:00:00Z" })).toEqual([]);
  });
});

describe("assertNoContactValues", () => {
  test("passes a clean payload", () => {
    expect(() => assertNoContactValues({ round: "seed" })).not.toThrow();
  });

  test("throws on a contact value", () => {
    expect(() => assertNoContactValues({ note: "a@b.co" })).toThrow(
      /must not contain contact values/,
    );
  });

  // The message has to name the field, or the person debugging it has to guess which of twelve keys is the
  // problem.
  test("the error names the offending path and reason", () => {
    let message = "";
    try {
      assertNoContactValues({ exec: { work_email: "a@b.co" } });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("payload.exec.work_email");
    expect(message).toContain("forbidden_key");
  });

  test("the error points at the right alternative", () => {
    let message = "";
    try {
      assertNoContactValues({ phone: "+14155550123" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("Reference the person by id");
  });
});
