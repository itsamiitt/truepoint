// chromeExtension.test.ts — the chrome_extension capture connector's HARD consent/ToS gate (I6). Asserts that
// validateEnvelope fail-closes on a missing/invalid consent context, a missing capture URL, or a missing workspace
// scope, and passes a well-formed capture; and that toRawObservations preserves records verbatim. Pure logic.

import { describe, expect, test } from "bun:test";
import type { IngestionEnvelope } from "@leadwolf/types";
import { chromeExtensionConnector } from "./chromeExtension.ts";

/** A well-formed chrome_extension capture envelope; tests override one field to exercise each gate. */
const base = (): IngestionEnvelope => ({
  source: "chrome_extension",
  scope: { tenantId: "t-1", workspaceId: "w-1" },
  idempotencyKey: "k1",
  collectedAt: "2026-01-01T00:00:00.000Z",
  consent: { basis: "legitimate_interest", sourceUrl: "https://www.example.com/in/jane" },
  records: [{ name: "Jane Doe", title: "VP Sales" }],
});

describe("chromeExtensionConnector.validateEnvelope", () => {
  test("accepts a well-formed capture (permitted basis + sourceUrl + workspace)", () => {
    expect(() => chromeExtensionConnector.validateEnvelope(base())).not.toThrow();
  });

  test("rejects a capture with NO consent context", () => {
    expect(() =>
      chromeExtensionConnector.validateEnvelope({ ...base(), consent: undefined }),
    ).toThrow();
  });

  test("rejects a non-permitted lawful basis (fail-closed)", () => {
    expect(() =>
      chromeExtensionConnector.validateEnvelope({
        ...base(),
        consent: { basis: "marketing_blast", sourceUrl: "https://www.example.com/in/jane" },
      }),
    ).toThrow();
  });

  test("rejects a capture with no sourceUrl (no ToS/BrowserGate audit trail)", () => {
    expect(() =>
      chromeExtensionConnector.validateEnvelope({ ...base(), consent: { basis: "consent" } }),
    ).toThrow();
  });

  test("rejects a capture with no workspace scope", () => {
    expect(() =>
      chromeExtensionConnector.validateEnvelope({ ...base(), scope: { tenantId: "t-1" } }),
    ).toThrow();
  });
});

describe("chromeExtensionConnector.toRawObservations", () => {
  test("preserves the records verbatim (mapping is the shared pipeline's job)", () => {
    const env = base();
    expect(chromeExtensionConnector.toRawObservations(env)).toEqual(env.records);
  });
});
