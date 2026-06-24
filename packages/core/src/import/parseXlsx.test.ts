import { describe, expect, test } from "bun:test";
// parseXlsx.test.ts — the XLSX adapter must produce the SAME { headers, rows } shape the CSV reader does
// (so the whole downstream pipeline is reused), reading the FIRST sheet only, coercing every cell to a trimmed
// string, neutralizing a leading formula trigger (CSV-injection), and rejecting empty/over-cap/wrong-shape
// input cleanly. `parseImportFile` must dispatch a .xlsx filename to this adapter (bytes) and a .csv to the CSV
// reader (text), erroring on a text/bytes mismatch rather than mis-parsing.
import { ImportValidationError } from "@leadwolf/types";
import * as XLSX from "xlsx";
import { parseImportFile } from "./parseFile.ts";
import { parseXlsx } from "./parseXlsx.ts";

/** Build an .xlsx workbook (as bytes) from a matrix of cell values, for the parser to read back. */
function xlsxBytes(
  matrix: unknown[][],
  sheets: { name: string; matrix: unknown[][] }[] = [],
): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), "Sheet1");
  for (const s of sheets)
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.matrix), s.name);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

describe("parseXlsx", () => {
  test("parses headers + rows into the same shape as parseCsv", () => {
    const { headers, rows } = parseXlsx(
      xlsxBytes([
        ["Email", "First Name"],
        ["jane@acme.com", "Jane"],
        ["john@acme.com", "John"],
      ]),
    );
    expect(headers).toEqual(["Email", "First Name"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Email: "jane@acme.com", "First Name": "Jane" });
  });

  test("coerces numeric / mixed cells to trimmed strings", () => {
    const { rows } = parseXlsx(
      xlsxBytes([
        ["Email", "Score"],
        ["  ada@x.test  ", 42],
      ]),
    );
    expect(rows[0]).toEqual({ Email: "ada@x.test", Score: "42" });
  });

  test("reads the FIRST sheet only", () => {
    const bytes = xlsxBytes(
      [["Email"], ["first@x.test"]],
      [{ name: "Other", matrix: [["Email"], ["other@x.test"]] }],
    );
    const { rows } = parseXlsx(bytes);
    expect(rows).toEqual([{ Email: "first@x.test" }]);
  });

  test("ignores blank rows", () => {
    const { rows } = parseXlsx(xlsxBytes([["Email"], [""], ["jane@acme.com"], [""]]));
    expect(rows).toHaveLength(1);
  });

  test("neutralizes a leading formula trigger (CSV-injection guard)", () => {
    const { rows } = parseXlsx(
      xlsxBytes([["Name"], ["=1+1"], ["+SUM(A1)"], ["@cmd"], ["-2"], ["safe"]]),
    );
    expect(rows.map((r) => r.Name)).toEqual(["'=1+1", "'+SUM(A1)", "'@cmd", "'-2", "safe"]);
  });

  test("throws a clean error for empty / corrupt input", () => {
    expect(() => parseXlsx(new Uint8Array(0))).toThrow(ImportValidationError);
    expect(() => parseXlsx(new Uint8Array([1, 2, 3, 4]))).toThrow(ImportValidationError);
  });
});

describe("parseImportFile dispatch", () => {
  test("routes a .xlsx filename to the xlsx adapter (bytes)", () => {
    const bytes = xlsxBytes([["Email"], ["x@y.test"]]);
    const { rows } = parseImportFile(bytes, "leads.xlsx");
    expect(rows).toEqual([{ Email: "x@y.test" }]);
  });

  test("routes a .csv filename to the csv reader (text)", () => {
    const { rows } = parseImportFile("Email\nx@y.test\n", "leads.csv");
    expect(rows).toEqual([{ Email: "x@y.test" }]);
  });

  test("rejects text for an .xlsx (must be bytes) and bytes for a .csv (must be text)", () => {
    expect(() => parseImportFile("not a workbook", "leads.xlsx")).toThrow(ImportValidationError);
    expect(() => parseImportFile(new Uint8Array([1, 2, 3]), "leads.csv")).toThrow(
      ImportValidationError,
    );
  });

  test("rejects a legacy .xls cleanly (the OLE2 binary the OOXML adapter can't read)", () => {
    // A .xls is routed to neither parser; it gets a clear "save as .xlsx or .csv" error rather than being
    // mis-read as CSV text or rejected as a corrupt .xlsx.
    expect(() => parseImportFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), "old.xls")).toThrow(
      ImportValidationError,
    );
    expect(() => parseImportFile("anything", "old.xls")).toThrow(ImportValidationError);
  });
});
