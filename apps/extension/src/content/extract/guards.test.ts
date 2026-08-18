import { describe, expect, test } from "bun:test";
import { firstPlausible, isPlausiblePersonName, isPlausibleShortField } from "./guards.ts";

describe("isPlausiblePersonName", () => {
  test("accepts ordinary names", () => {
    expect(isPlausiblePersonName("Priya Natarajan")).toBe(true);
    expect(isPlausiblePersonName("José Álvarez-Ruiz")).toBe(true);
    expect(isPlausiblePersonName("Li Wei")).toBe(true);
  });
  test("rejects page chrome and UI labels", () => {
    expect(isPlausiblePersonName("Sales Navigator Lead Page")).toBe(false);
    expect(isPlausiblePersonName("LinkedIn")).toBe(false);
    expect(isPlausiblePersonName("Search results")).toBe(false);
  });
  test("rejects sentences, separators, empties, non-letters", () => {
    expect(isPlausiblePersonName("Head of Sales at Acme Corp Europe Middle East")).toBe(false);
    expect(isPlausiblePersonName("Name | Title")).toBe(false);
    expect(isPlausiblePersonName("")).toBe(false);
    expect(isPlausiblePersonName(undefined)).toBe(false);
    expect(isPlausiblePersonName("12345")).toBe(false);
  });
});

describe("isPlausibleShortField", () => {
  test("headline mentioning the host site is fine when it is a role", () => {
    expect(isPlausibleShortField("Engineer at LinkedIn")).toBe(true);
    expect(isPlausibleShortField("Sales Navigator")).toBe(false);
  });
});

describe("firstPlausible", () => {
  test("returns the first candidate passing the guard, in selector order", () => {
    const root = {
      querySelector: (sel: string) =>
        sel === "h1"
          ? { textContent: "Sales Navigator Lead Page" }
          : sel === ".name"
            ? { textContent: "Ada Lovelace" }
            : null,
    } as unknown as ParentNode;
    expect(firstPlausible(root, ["h1", ".name"], isPlausiblePersonName)).toBe("Ada Lovelace");
    expect(firstPlausible(root, ["h1"], isPlausiblePersonName)).toBeUndefined();
  });
});
