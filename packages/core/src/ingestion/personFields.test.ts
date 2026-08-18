import { describe, expect, test } from "bun:test";
import { names, splitLocation, str } from "./personFields.ts";

describe("str", () => {
  test("trims, rejects blanks and non-strings", () => {
    expect(str("  Ada  ")).toBe("Ada");
    expect(str("   ")).toBeUndefined();
    expect(str(42)).toBeUndefined();
    expect(str(undefined)).toBeUndefined();
  });
});

describe("splitLocation", () => {
  test("city + country", () => {
    expect(splitLocation("Bengaluru, India")).toEqual({ city: "Bengaluru", country: "India" });
  });
  test("three parts: everything but the last is the city", () => {
    expect(splitLocation("Fort Lauderdale, Florida, United States")).toEqual({
      city: "Fort Lauderdale, Florida",
      country: "United States",
    });
  });
  test("single token stays city-only (never guess a country)", () => {
    expect(splitLocation("Remote")).toEqual({ city: "Remote" });
  });
  test("blank input", () => {
    expect(splitLocation(undefined)).toEqual({});
  });
});

describe("names", () => {
  test("explicit parts win", () => {
    expect(names({ firstName: "Ada", lastName: "Lovelace", fullName: "Ignored X" })).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });
  test("single-token full name is a first name", () => {
    expect(names({ fullName: "Prince" })).toEqual({ firstName: "Prince" });
  });
  test("multi-word first name, last token is the surname", () => {
    expect(names({ fullName: "Maria del Carmen Rodriguez" })).toEqual({
      firstName: "Maria del Carmen",
      lastName: "Rodriguez",
    });
  });
  test("nothing to derive", () => {
    expect(names({})).toEqual({});
  });
});
