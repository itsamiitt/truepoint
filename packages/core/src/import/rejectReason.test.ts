// rejectReason.test.ts — the T-S6 tripwire (import-and-data-model-redesign 13 §3.3 / §11 worst-case #2): the
// `reject_reason` writer rule is `code` or `code:column_ref`, NEVER a cell value. `rejectReasonToken` is the
// single enforcement point (used by runFastImport's ledger writer AND both artifacts), so proving its output
// shape + running a PII-pattern sweep over it — plus over the aggregate error report — regression-tests the
// never-log-PII invariant instead of trusting it. (The repair CSV legitimately echoes the full row under §4's
// gate, so it is NOT swept here; the ERROR REPORT, whose small blast radius invites forwarding, is.)

import { type RejectedRow, importRejectCode, rejectReasonToken } from "@leadwolf/types";
import { expect, test } from "bun:test";
import { buildErrorReportCsv } from "./artifactWriter.ts";

/** The sanctioned token shape: a lowercase snake_case code, optionally `:column_ref` (a canonical field name —
 *  letters/digits/underscore, no value). Anchored, so any stray whitespace/value fails it. */
const TOKEN_RE = /^[a-z][a-z0-9_]*(?::[a-zA-Z][a-zA-Z0-9_]*)?$/;

/** PII value fingerprints (mirrors artifactWriter.redactValues): an email-like token or a 7+-digit run. If a
 *  token/report ever contains one, a raw value leaked. */
const PII_RE = [/[^\s,@"']+@[^\s,@"']+\.[^\s,@"']+/, /\d{7,}/];
function hasPii(s) {
  return PII_RE.some((re) => re.test(s));
}

const ALL_CODES = importRejectCode.options;

test("rejectReasonToken emits a code or code:column token for every code — never a value", () => {
  for (const code of ALL_CODES) {
    expect(rejectReasonToken(code)).toMatch(TOKEN_RE);
    expect(rejectReasonToken(code, "email")).toBe(`${code}:email`);
    expect(rejectReasonToken(code, "email")).toMatch(TOKEN_RE);
  }
});

test("a PII-shaped column ref would still not smuggle a value past the token shape assertion", () => {
  // The writer only ever passes CANONICAL field names as the column; but even a hostile column arg is
  // constrained by the token contract the ledger/artifacts assert against — a value-shaped column fails it.
  const token = rejectReasonToken("malformed_email", "user@evil.com");
  expect(hasPii(token)).toBe(true); // proves the fingerprint works…
  expect(token).not.toMatch(TOKEN_RE); // …and that such a token would be REJECTED by the shape gate (T-S6)
});

test("no produced token for a real reject carries PII (email / long-digit run)", () => {
  for (const code of ALL_CODES) {
    expect(hasPii(rejectReasonToken(code))).toBe(false);
    expect(hasPii(rejectReasonToken(code, "phone"))).toBe(false);
  }
});

test("the aggregate error report is PII-free even when the input rows carry values (13 §3.3 sweep)", () => {
  const rejected: RejectedRow[] = [
    {
      row: 0,
      field: "email",
      code: "malformed_email",
      reason: "The value alice@example.com is not a valid email.",
      raw: { email: "alice@example.com", phone: "5551234567", name: "Alice" },
    },
    {
      row: 1,
      field: "email",
      code: "malformed_email",
      reason: "Malformed email address.",
      raw: { email: "bob@evil.co", phone: "9998887777", name: "Bob" },
    },
  ];
  const report = buildErrorReportCsv(rejected);
  // The error_code column values are token-shaped; the whole report leaks no email or long-digit value.
  expect(report).not.toMatch(PII_RE[0]); // no email survives (redacted)
  expect(report).not.toMatch(PII_RE[1]); // no 7+-digit run survives
  expect(report).toContain("malformed_email"); // the taxonomy code IS present
  expect(report).toContain("_REDACTED_"); // the value fragment in the detail was scrubbed
});
