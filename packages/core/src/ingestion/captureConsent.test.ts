// captureConsent.test.ts — a CAPTURE source may not land a record without a lawful basis.
//
// CLAUDE.md rule 4 forbids, as a hard constraint, "any contribution flow without explicit consent + provenance
// logging", and outcome A-01 is "every stored field has provenance and a lawful basis". The envelope schema
// makes `consent` OPTIONAL — correctly, because server-side sources (admin_upload, enrichment, crm) carry
// their basis elsewhere — and states the rule in prose instead: "Consent context — REQUIRED for capture
// sources (chrome_extension / web_form)".
//
// A rule that lives in a schema comment is enforced by whoever reads it. chromeExtension.ts does enforce it,
// and chromeExtension.test.ts proves it thoroughly — five negative cases, including a missing consent context
// and a non-permitted basis. What nothing covered is the NEXT capture connector. `web_form` is already in the
// ConnectorId enum with no implementation; the day someone writes one, the only thing telling them consent is
// mandatory is a comment two files away.
//
// So this asserts the property against the connector REGISTRY rather than against one connector: every
// capture-source connector that exists must fail closed on an envelope with no consent. It is a test that
// passes today and exists entirely for the commit that adds the next source.
import { describe, expect, test } from "bun:test";
import { type IngestionEnvelope, connectorId } from "@leadwolf/types";
import { adminUploadConnector } from "./connectors/adminUpload.ts";
import { chromeExtensionConnector } from "./connectors/chromeExtension.ts";
import type { Connector } from "./registry.ts";

/** The sources the envelope schema names as CAPTURE sources — the ones a person is browsing when the record is
 *  produced, as opposed to a server-side source that carries its basis elsewhere. Kept to exactly what the
 *  schema says rather than to a guess: `email_signature`, `partner` and `rep_submission` may well belong here
 *  too, but that is a classification the schema's author should make, and the enum ratchet below is what
 *  forces the question. */
const CAPTURE_SOURCES = new Set<string>(["chrome_extension", "web_form"]);

/** Connectors this test can see. Imported directly rather than through registerBuiltinConnectors(), which
 *  registers chrome_extension only when CHROME_EXTENSION_ENABLED is on — under the test env it is off, so a
 *  registry-driven loop would silently check NOTHING and pass. That is the failure mode this whole file is
 *  about, so it is not one to reproduce inside it. */
const KNOWN_CONNECTORS: Connector[] = [chromeExtensionConnector, adminUploadConnector];

function envelopeFor(source: string): IngestionEnvelope {
  return {
    source,
    scope: {
      tenantId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    },
    idempotencyKey: "capture-consent-probe",
    collectedAt: "2026-01-01T00:00:00.000Z",
    records: [{ name: "Jane Doe", title: "VP Sales" }],
    // No `consent` — the whole point.
  } as IngestionEnvelope;
}

describe("rule 4 — a capture source fails closed without a lawful basis", () => {
  const captureConnectors = KNOWN_CONNECTORS.filter((c) => CAPTURE_SOURCES.has(c.id));

  test("at least one capture connector is under test", () => {
    // Without this, a rename or a moved import turns the loop below into zero iterations and the suite reports
    // green while asserting nothing.
    expect(captureConnectors.length).toBeGreaterThan(0);
  });

  for (const connector of captureConnectors) {
    test(`${connector.id} rejects an envelope with no consent context`, () => {
      let caught: unknown;
      try {
        connector.validateEnvelope(envelopeFor(connector.id));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
    });
  }

  test("a server-side source is NOT held to the capture rule", () => {
    // admin_upload carries its basis elsewhere, so demanding consent here would be wrong — and a version of
    // this test that applied the rule to every connector would force exactly that mistake.
    expect(CAPTURE_SOURCES.has(adminUploadConnector.id)).toBe(false);
  });
});

describe("adding an ingestion source forces a capture/server-side decision", () => {
  test("the ConnectorId enum is the set this file has classified", () => {
    // A RATCHET, not a restriction. Every id below has been considered against the capture rule; a new one has
    // not. When this fails, add the id here AND to CAPTURE_SOURCES above if a person is browsing when the
    // record is produced — that is the test's entire purpose, and the failure message is the prompt.
    // `.map(String)` on both sides: connectorId.options is a literal-union tuple, so comparing it against a
    // plain string[] is a typecheck error rather than a test failure — caught by `tsc --noEmit`, which reaches
    // this file because packages/core keeps its tests in src/.
    expect([...connectorId.options].map(String).sort()).toEqual(
      [
        "admin_upload",
        "api",
        "chrome_extension",
        "crm",
        "email_signature",
        "enrichment",
        "marketplace",
        "partner",
        "rep_submission",
        "web_form",
      ].sort(),
    );
  });
});
