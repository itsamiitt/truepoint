// artifactWriter.test.ts — T-S1 (formula-injection neutralization) + T-S5 (error-report redaction) for the
// single server-side artifact writer (import-and-data-model-redesign 13 §4.5/§3.3, steps S-I7/S-S3). Pure,
// dependency-free unit gates over the exact bytes; the itest half (proxied download + audit) is CI-owed.

import { describe, expect, test } from "bun:test";
import type { RejectedRow } from "@leadwolf/types";
import {
  buildErrorReportCsv,
  buildRepairCsv,
  neutralizeCell,
  redactValues,
} from "./artifactWriter.ts";

describe("neutralizeCell (T-S1)", () => {
  test("prefixes a single quote on every formula-trigger first character", () => {
    expect(neutralizeCell("=WEBSERVICE(1)")).toBe("'=WEBSERVICE(1)");
    expect(neutralizeCell("+1-555-000")).toBe("'+1-555-000");
    expect(neutralizeCell("-42")).toBe("'-42");
    expect(neutralizeCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  test("catches tab/CR/LF-led variants (a spreadsheet strips the control char before evaluating)", () => {
    expect(neutralizeCell("\t=cmd|'/c calc'!A1")).toBe("'\t=cmd|'/c calc'!A1");
    expect(neutralizeCell("\r=1+1")).toBe("'\r=1+1");
    expect(neutralizeCell("\n@x")).toBe("'\n@x");
  });

  test("leaves benign and empty cells untouched", () => {
    expect(neutralizeCell("john@acme.com")).toBe("john@acme.com"); // '@' is not the FIRST char
    expect(neutralizeCell("Acme Inc")).toBe("Acme Inc");
    expect(neutralizeCell("")).toBe("");
  });
});

describe("buildRepairCsv neutralization (T-S1)", () => {
  test("neutralizes hostile cells in the echoed original columns; no bare formula survives", () => {
    const rows: RejectedRow[] = [
      {
        row: 0,
        field: null,
        reason: "Row has no identifier.",
        code: "missing_identifier",
        raw: { Name: "=cmd|'/c calc'!A1", Note: "fine" },
      },
    ];
    const csv = buildRepairCsv(rows);
    // The hostile cell is neutralized (leading quote); no cell begins a formula.
    expect(csv).toContain("'=cmd");
    expect(csv).not.toMatch(/(^|,|")=cmd/); // never a bare, evaluable `=cmd` at a field boundary
    // Appended taxonomy columns present; the code cell is the typed token, never a value.
    expect(csv.split("\r\n")[0]).toContain("tp__error_code");
    expect(csv).toContain("missing_identifier");
  });
});

describe("buildErrorReportCsv redaction (T-S5)", () => {
  test("groups by code:column and redacts value fragments; no raw value anywhere", () => {
    const rows: RejectedRow[] = [
      {
        row: 2,
        field: "email",
        reason: "Malformed email address.",
        code: "malformed_email",
        raw: { Email: "not-an-email" },
      },
      {
        row: 3,
        field: null,
        // A processing_error whose free-text reason embeds real PII — must be scrubbed in the aggregate.
        reason: "duplicate key value: jane.doe@secret.example.com / 15551234567",
        code: "processing_error",
        raw: { Email: "jane.doe@secret.example.com", Phone: "15551234567" },
      },
    ];
    const csv = buildErrorReportCsv(rows);
    // No raw value fragment survives into the shareable aggregate — the email and phone are gone…
    expect(csv).not.toContain("jane.doe@secret.example.com");
    expect(csv).not.toContain("15551234567");
    // …and the free-text processing_error `err.message` (which regex redaction can't fully scrub — a name or a
    // bare domain would slip) is collapsed to the stable non-PII label, never surfaced at all.
    expect(csv).not.toContain("duplicate key value");
    expect(csv).toContain("Processing error");
    // Aggregate shape: codes + columns + counts + sample lines, one bucket per code:column.
    expect(csv.split("\r\n")[0]).toBe("error_code,column,impact_count,sample_lines,sample_detail");
    expect(csv).toContain("malformed_email");
    expect(csv).toContain("processing_error");
  });
});

describe("redactValues", () => {
  test("scrubs email-like and long-digit fragments, keeps codes/columns", () => {
    expect(redactValues("malformed_email:email")).toBe("malformed_email:email");
    expect(redactValues("value a@b.co bad")).toBe("value _REDACTED_ bad");
    expect(redactValues("id 1234567 seen")).toBe("id _REDACTED_ seen");
  });
});
