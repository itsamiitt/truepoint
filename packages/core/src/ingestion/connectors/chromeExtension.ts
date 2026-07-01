// chromeExtension.ts — the `chrome_extension` ingestion connector (prospect-database-platform I6 / audit P07). A
// CAPTURE source: a rep's browser extension submits observations captured from a page they are viewing. Because it
// captures THIRD-PARTY PII from the open web, it is HARD-GATED at the boundary — validateEnvelope REJECTS any
// envelope without a valid consent/ToS context (a permitted lawful basis + the capture source URL, the
// ToS/BrowserGate audit trail, 06/09). ADDITIVE + DARK: registered ONLY when CHROME_EXTENSION_ENABLED is on (legal
// sign-off). This connector validates + consent-gates + hands the records to the shared pipeline verbatim; it
// NEVER lands or surfaces PII itself. The SUPPRESSION check-before-surfacing + the async evidence→resolve→enrich→
// land pipeline are the shared pipeline's job (later slices) — a suppressed prospect must be blocked there before
// anything is surfaced.

import { ValidationError } from "@leadwolf/types";
import type { IngestionEnvelope, RawObservation } from "@leadwolf/types";
import type { Connector } from "../registry.ts";

/**
 * Lawful bases a CAPTURE source may assert (aligned with consentContext.basis; the ToS/BrowserGate posture, 06/09).
 * A placeholder set — legal refines it at sign-off. A basis outside this set is rejected (fail-closed).
 */
const PERMITTED_CAPTURE_BASES = new Set(["consent", "legitimate_interest", "contract"]);

export const chromeExtensionConnector: Connector = {
  id: "chrome_extension",
  validateEnvelope(envelope: IngestionEnvelope): void {
    // HARD CONSENT/ToS GATE — a capture source MUST carry a consent context (unlike server-side admin_upload, which
    // carries its basis at the workspace level). Fail-closed: anything missing or not permitted is rejected.
    const consent = envelope.consent;
    if (!consent) {
      throw new ValidationError(
        "chrome_extension requires a consent context (lawful basis + capture source).",
      );
    }
    if (!PERMITTED_CAPTURE_BASES.has(consent.basis)) {
      throw new ValidationError(
        `chrome_extension consent basis '${consent.basis}' is not a permitted lawful basis for capture.`,
      );
    }
    // A capture MUST record WHERE it happened — the ToS/BrowserGate audit trail. No source URL ⇒ reject.
    if (!consent.sourceUrl) {
      throw new ValidationError(
        "chrome_extension consent requires the capture sourceUrl (ToS/BrowserGate audit trail).",
      );
    }
    // A capture is workspace-scoped (a rep in a workspace made it).
    if (!envelope.scope.workspaceId) {
      throw new ValidationError("chrome_extension requires a workspace scope.");
    }
  },
  toRawObservations(envelope: IngestionEnvelope): RawObservation[] {
    // Verbatim — canonical-field mapping AND the suppression-block-before-surface check are the shared pipeline's
    // job (later slices), so a bad mapping or a missed suppression can never live in a connector. This connector
    // only validates + consent-gates; it never lands or surfaces PII.
    return envelope.records;
  },
};
