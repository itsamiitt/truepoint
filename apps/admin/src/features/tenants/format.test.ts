// format.test.ts — pins the Tenants area's pure presentation helpers: status → badge tone (the four-tone
// monochrome mapping), a stable short date with an em-dash fallback (never "Invalid Date"), and a
// thousands-separated integer. These are the only pure, exported helpers the area introduced.

import { describe, expect, it } from "bun:test";
import { formatInt, shortDate, statusTone } from "./format.ts";

describe("statusTone", () => {
  it("maps lifecycle statuses to the right tone", () => {
    expect(statusTone("active")).toBe("success");
    expect(statusTone("pending")).toBe("warning");
    expect(statusTone("invited")).toBe("warning");
    expect(statusTone("suspended")).toBe("danger");
    expect(statusTone("removed")).toBe("danger");
  });

  it("falls back to muted for unknown statuses", () => {
    expect(statusTone("whatever")).toBe("muted");
    expect(statusTone("")).toBe("muted");
  });
});

describe("shortDate", () => {
  it("formats a valid ISO timestamp to YYYY-MM-DD", () => {
    expect(shortDate("2026-06-14T10:00:00.000Z")).toBe("2026-06-14");
  });

  it("returns an em dash for missing or unparseable input", () => {
    expect(shortDate(null)).toBe("—");
    expect(shortDate(undefined)).toBe("—");
    expect(shortDate("not-a-date")).toBe("—");
  });
});

describe("formatInt", () => {
  it("thousands-separates", () => {
    expect(formatInt(1000)).toBe("1,000");
    expect(formatInt(0)).toBe("0");
  });
});
