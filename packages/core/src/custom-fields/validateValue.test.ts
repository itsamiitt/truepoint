// validateValue.test.ts — unit coverage for the pure custom-field value validator (ADR-0028, gap G-REV-5).
// No DB; asserts each field type's accept/reject rule + the required/null contract. The cross-workspace
// persistence + shallow-merge behavior is proven separately in packages/db/test/customFields.itest.ts.

import { describe, expect, test } from "bun:test";
import { type FieldDefinitionForValidation, validateValue } from "./validateValue.ts";

const def = (
  over: Partial<FieldDefinitionForValidation> & Pick<FieldDefinitionForValidation, "fieldType">,
): FieldDefinitionForValidation => ({
  key: "f",
  label: "F",
  options: null,
  required: false,
  archived: false,
  ...over,
});

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

describe("validateValue", () => {
  test("null clears an optional field; a required field rejects null", () => {
    expect(validateValue(def({ fieldType: "text" }), null)).toBeNull();
    expect(validateValue(def({ fieldType: "text" }), undefined)).toBeNull();
    expect(
      String(caught(() => validateValue(def({ fieldType: "text", required: true }), null))),
    ).toContain("required");
  });

  test("text accepts a string, rejects non-strings and over-length", () => {
    expect(validateValue(def({ fieldType: "text" }), "hello")).toBe("hello");
    expect(String(caught(() => validateValue(def({ fieldType: "text" }), 5)))).toContain(
      "must be text",
    );
    expect(
      String(caught(() => validateValue(def({ fieldType: "text" }), "x".repeat(2001)))),
    ).toContain("at most");
  });

  test("number accepts finite numbers (incl. 0), rejects strings/NaN/Infinity", () => {
    expect(validateValue(def({ fieldType: "number" }), 0)).toBe(0); // falsy-zero must survive
    expect(validateValue(def({ fieldType: "number" }), -3.5)).toBe(-3.5);
    expect(String(caught(() => validateValue(def({ fieldType: "number" }), "3")))).toContain(
      "number",
    );
    expect(
      String(caught(() => validateValue(def({ fieldType: "number" }), Number.POSITIVE_INFINITY))),
    ).toContain("number");
  });

  test("boolean accepts true/false (incl. false), rejects non-booleans", () => {
    expect(validateValue(def({ fieldType: "boolean" }), false)).toBe(false); // falsy-false must survive
    expect(validateValue(def({ fieldType: "boolean" }), true)).toBe(true);
    expect(String(caught(() => validateValue(def({ fieldType: "boolean" }), "true")))).toContain(
      "true or false",
    );
  });

  test("date accepts YYYY-MM-DD, rejects other shapes", () => {
    expect(validateValue(def({ fieldType: "date" }), "2026-06-17")).toBe("2026-06-17");
    expect(String(caught(() => validateValue(def({ fieldType: "date" }), "06/17/2026")))).toContain(
      "date",
    );
    expect(String(caught(() => validateValue(def({ fieldType: "date" }), "not-a-date")))).toContain(
      "date",
    );
  });

  test("url accepts http(s), rejects other schemes and non-URLs", () => {
    expect(validateValue(def({ fieldType: "url" }), "https://acme.com/x")).toBe(
      "https://acme.com/x",
    );
    expect(validateValue(def({ fieldType: "url" }), "http://acme.com")).toBe("http://acme.com");
    expect(
      String(caught(() => validateValue(def({ fieldType: "url" }), "ftp://acme.com"))),
    ).toContain("http(s)");
    expect(String(caught(() => validateValue(def({ fieldType: "url" }), "not a url")))).toContain(
      "valid URL",
    );
  });

  test("select accepts a declared option, rejects anything else", () => {
    const d = def({ fieldType: "select", options: ["gold", "silver"] });
    expect(validateValue(d, "gold")).toBe("gold");
    expect(String(caught(() => validateValue(d, "platinum")))).toContain("must be one of");
    expect(String(caught(() => validateValue(d, 1)))).toContain("must be one of");
  });
});
