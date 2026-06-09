// parseFile.test.ts — the CSV reader must handle quotes, embedded commas/newlines, and "" escapes; the
// column-mapper must select only mapped, non-empty fields.
import { describe, expect, test } from "bun:test";
import { mapRow } from "./columnMap.ts";
import { parseCsv } from "./parseFile.ts";

describe("parseCsv", () => {
  test("parses headers + rows", () => {
    const { headers, rows } = parseCsv("Email,First Name\njane@acme.com,Jane\njohn@acme.com,John\n");
    expect(headers).toEqual(["Email", "First Name"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Email: "jane@acme.com", "First Name": "Jane" });
  });

  test("handles quoted fields with embedded commas, newlines and escaped quotes", () => {
    const { rows } = parseCsv('Name,Note\n"Doe, Jane","line1\nline2"\n"a ""quote""",ok\n');
    expect(rows[0]).toEqual({ Name: "Doe, Jane", Note: "line1\nline2" });
    expect(rows[1]).toEqual({ Name: 'a "quote"', Note: "ok" });
  });

  test("ignores blank lines", () => {
    const { rows } = parseCsv("Email\n\njane@acme.com\n\n");
    expect(rows).toHaveLength(1);
  });
});

describe("mapRow", () => {
  test("selects mapped non-empty fields by canonical key", () => {
    const mapped = mapRow(
      { Email: "jane@acme.com", "First Name": "Jane", Junk: "ignore", Blank: "" },
      { email: "Email", firstName: "First Name", lastName: "Blank" },
    );
    expect(mapped).toEqual({ email: "jane@acme.com", firstName: "Jane" });
  });
});
