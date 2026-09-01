// returnPath.test.ts — the open-redirect wall on the login return stash, pinned. Every rejected shape here
// is a way an attacker-influenced stash could have walked the user off-origin after login.
import { describe, expect, it } from "bun:test";
import { safeReturnPath } from "./returnPath.ts";

describe("safeReturnPath", () => {
  it("honors a same-origin path with query", () => {
    expect(safeReturnPath("/search?person=jane-doe")).toBe("/search?person=jane-doe");
    expect(safeReturnPath("/search")).toBe("/search");
  });

  it("rejects everything that could leave the origin", () => {
    expect(safeReturnPath("//evil.example")).toBeNull(); // protocol-relative
    expect(safeReturnPath("https://evil.example/x")).toBeNull(); // absolute URL
    expect(safeReturnPath("/\\evil.example")).toBeNull(); // backslash normalizes to //
    expect(safeReturnPath("search")).toBeNull(); // relative — not a rooted path
    expect(safeReturnPath("")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
  });
});
