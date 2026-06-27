// templates.test.ts — hermetic unit tests for the parts of the template service that DON'T need a database:
// (1) the opaque keyset cursor codec (round-trip + malformed-input rejection), and (2) the render-safety
// contract the server-side preview relies on (the canonical merge-field allowlist + value escaping). The
// DB-coupled paths (owner-scope D8, IDOR→404, version immutability, pagination keyset) are proven end-to-end
// on real Postgres in packages/db/test/templateIsolation.itest.ts.

import { describe, expect, test } from "bun:test";
import { ValidationError } from "@leadwolf/types";
import { renderTemplate } from "./renderTemplate.ts";
import { TEMPLATE_MERGE_FIELDS, decodeCursor, encodeCursor } from "./templates.ts";

describe("template list cursor codec", () => {
  test("round-trips a full-precision updated_at + id", () => {
    const key = "2026-06-27 12:34:56.123456+00";
    const id = "0190f1a2-3b4c-7d8e-9f01-23456789abcd";
    const decoded = decodeCursor(encodeCursor(key, id));
    expect(decoded.updatedAtText).toBe(key);
    expect(decoded.id).toBe(id);
  });

  test("the cursor is opaque (base64url, no separator leak)", () => {
    const token = encodeCursor("2026-06-27 12:34:56.000001+00", "id-1");
    // base64url alphabet only — no '|', '+', '/', or '=' padding.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("rejects a malformed cursor with a ValidationError (never a silent reset)", () => {
    expect(() => decodeCursor("@@@not-base64url@@@!!!")).toThrow(ValidationError);
    // base64url of a string with no separator → still rejected.
    expect(() => decodeCursor(Buffer.from("no-separator", "utf8").toString("base64url"))).toThrow(
      ValidationError,
    );
    // empty id half → rejected.
    expect(() => decodeCursor(Buffer.from("2026-01-01|", "utf8").toString("base64url"))).toThrow(
      ValidationError,
    );
  });

  test("rejects a decodable-but-garbage cursor by CONTENT (would otherwise hit the SQL cast as a 500)", () => {
    const uuid = "0190f1a2-3b4c-7d8e-9f01-23456789abcd";
    const ts = "2026-06-27 12:34:56.123456+00";
    // valid structure (decodes, has '|', both halves non-empty) but the timestamp half is not a timestamp.
    expect(() =>
      decodeCursor(Buffer.from(`notatimestamp|${uuid}`, "utf8").toString("base64url")),
    ).toThrow(ValidationError);
    // valid timestamp half, but the id half is not a uuid.
    expect(() => decodeCursor(Buffer.from(`${ts}|notauuid`, "utf8").toString("base64url"))).toThrow(
      ValidationError,
    );
    // the canary repro from review: base64url("x|y") decodes cleanly, passes structure, fails content.
    expect(() => decodeCursor("eHx5")).toThrow(ValidationError);
  });
});

describe("preview render-safety contract (the canonical merge-field allowlist)", () => {
  const allowed = new Set<string>(TEMPLATE_MERGE_FIELDS);

  test("an untrusted merge VALUE is HTML-escaped in the body (no stored XSS)", () => {
    const out = renderTemplate(
      "Hi {{first_name}}",
      { first_name: "<script>alert(1)</script>" },
      {
        allowedKeys: allowed,
        escapeValues: true,
      },
    );
    expect(out).toBe("Hi &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).not.toContain("<script>");
  });

  test("an unknown / non-allowlisted token resolves to its fallback, never the raw token", () => {
    const out = renderTemplate(
      "{{evil_token}}{{company | Acme}}",
      { evil_token: "x", company: "" },
      { allowedKeys: allowed, escapeValues: true },
    );
    // evil_token is not in the allowlist → drops to "" (its empty fallback); company falls back to "Acme".
    expect(out).toBe("Acme");
    expect(out).not.toContain("evil_token");
  });

  test("a value containing a token is inserted literally (single pass, no recursion)", () => {
    const out = renderTemplate(
      "{{first_name}}",
      { first_name: "{{last_name}}", last_name: "SHOULD_NOT_APPEAR" },
      { allowedKeys: allowed, escapeValues: false },
    );
    expect(out).toBe("{{last_name}}");
    expect(out).not.toContain("SHOULD_NOT_APPEAR");
  });

  test("the subject renders unescaped (plain-text), the body escaped", () => {
    const subject = renderTemplate(
      "Re: {{company}}",
      { company: "A & B" },
      {
        allowedKeys: allowed,
        escapeValues: false,
      },
    );
    expect(subject).toBe("Re: A & B");
  });
});
