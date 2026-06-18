// rejectedRowsCsv.test.ts — the rejected-rows artifact serializer (G-IMP-1). Fixed reason columns + the
// union of raw keys; RFC-4180 quoting for embedded commas/quotes/newlines; 1-based row numbers. Pure.

import { describe, expect, test } from "bun:test";
import type { RejectedRow } from "@leadwolf/types";
import { rejectedRowsToCsv } from "./rejectedRowsCsv.ts";

describe("rejectedRowsToCsv", () => {
  test("emits the fixed header + the union of raw keys, with 1-based row numbers", () => {
    const rows: RejectedRow[] = [
      {
        row: 0,
        field: "email",
        reason: "Malformed email address.",
        raw: { Email: "bad", Name: "A" },
      },
      { row: 4, field: null, reason: "No identity key.", raw: { Name: "B", Phone: "555" } },
    ];
    const csv = rejectedRowsToCsv(rows);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("rowNumber,field,reason,Email,Name,Phone");
    expect(lines[1]).toBe("1,email,Malformed email address.,bad,A,");
    expect(lines[2]).toBe("5,,No identity key.,,B,555");
  });

  test("RFC-4180-quotes cells containing commas, quotes, or newlines", () => {
    const rows: RejectedRow[] = [
      {
        row: 0,
        field: null,
        reason: 'Bad, "value"',
        raw: { Note: "line1\nline2", Co: "Acme, Inc." },
      },
    ];
    const csv = rejectedRowsToCsv(rows);
    const dataLine = csv.split("\r\n")[1] ?? "";
    expect(dataLine).toContain('"Bad, ""value"""');
    expect(dataLine).toContain('"line1\nline2"');
    expect(dataLine).toContain('"Acme, Inc."');
  });

  test("an empty input still yields the fixed header (never an empty file)", () => {
    expect(rejectedRowsToCsv([])).toBe("rowNumber,field,reason");
  });
});
