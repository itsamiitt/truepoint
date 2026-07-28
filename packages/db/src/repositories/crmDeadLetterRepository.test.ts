// crmDeadLetterRepository.test.ts — the DLQ's PURE guards (crm-sync 00 §4.8). The DB paths are covered by
// the CRM itests; what matters here is that a dead-letter row cannot become a PII leak or fail to be written.

import { describe, expect, test } from "bun:test";
import { classifyCrmError, scrubErrorDetail } from "./crmDeadLetterRepository.ts";

describe("classifyCrmError", () => {
  test("passes a known class straight through", () => {
    expect(classifyCrmError("rate_limited")).toBe("rate_limited");
    expect(classifyCrmError("validation")).toBe("validation");
  });

  test("maps the runner's auth outcomes onto the auth class", () => {
    expect(classifyCrmError("auth_expired")).toBe("auth");
    expect(classifyCrmError("auth_revoked")).toBe("auth");
  });

  test("maps transport outcomes onto provider_5xx", () => {
    expect(classifyCrmError("transient")).toBe("provider_5xx");
    expect(classifyCrmError("permanent")).toBe("provider_5xx");
  });

  test("maps the suppression refusal", () => {
    expect(classifyCrmError("subject_suppressed")).toBe("suppressed");
  });

  test("an UNFAMILIAR reason is 'unknown', never a throw", () => {
    // A dead-letter write is the last chance to record that a job failed. Throwing because the reason string
    // was unfamiliar would lose the evidence entirely — the one outcome worse than a vague class.
    expect(classifyCrmError("some_future_outcome")).toBe("unknown");
    expect(classifyCrmError(null)).toBe("unknown");
    expect(classifyCrmError(undefined)).toBe("unknown");
    expect(classifyCrmError("")).toBe("unknown");
  });

  test("an unknown reason never invents a class outside the closed enum", () => {
    // The column has a closed CHECK; a value outside it would fail the INSERT and lose the row.
    const allowed = new Set([
      "rate_limited",
      "auth",
      "validation",
      "conflict_unresolved",
      "transform",
      "not_found",
      "provider_5xx",
      "ssrf_blocked",
      "suppressed",
      "unknown",
    ]);
    for (const reason of ["", "???", "🙃", "DROP TABLE", "auth", "transform_failed"]) {
      expect(allowed.has(classifyCrmError(reason))).toBe(true);
    }
  });
});

describe("scrubErrorDetail", () => {
  test("redacts an email address a provider echoed back", () => {
    // The shape that most often smuggles PII into an error string.
    expect(scrubErrorDetail("could not update dana.scully@acme.com")).toBe(
      "could not update [email]",
    );
  });

  test("redacts a long digit run (a phone number)", () => {
    expect(scrubErrorDetail("invalid phone 14155552671")).toBe("invalid phone [number]");
  });

  test("leaves a short number alone — an HTTP status is not PII", () => {
    expect(scrubErrorDetail("provider returned 503")).toBe("provider returned 503");
  });

  test("truncates to the column width so the INSERT cannot fail on length", () => {
    // The failure path is exactly where a secondary failure is least affordable.
    expect(scrubErrorDetail("x".repeat(4000))).toHaveLength(1000);
  });

  test("null and empty stay null", () => {
    expect(scrubErrorDetail(null)).toBeNull();
    expect(scrubErrorDetail(undefined)).toBeNull();
    expect(scrubErrorDetail("")).toBeNull();
  });

  test("redaction happens BEFORE truncation, so a trailing address cannot survive", () => {
    const detail = `${"x".repeat(990)} dana@acme.com`;
    expect(scrubErrorDetail(detail)).not.toContain("acme.com");
  });
});
