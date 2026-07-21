// @forge/core — the factory brain (04): the S0 land stage (ingest), the versioned parser framework (P2),
// Forge-owned Fellegi-Sunter ER + dedup/merge/survivorship (P5), quality/validation rules (P3), and the
// ports the AI/provider adapters implement. Imports types/config only (never ai — core-must-not-import-ai).
import { forgeFlags } from "@leadwolf/config";
import { reviewStatus } from "@leadwolf/types";

export type { EnrichPort, VerifyPort } from "./ports.ts";
export * from "./ingest.ts";

// ── P2 parser framework (08-parser-framework) ─────────────────────────────────────────────────────────
export * from "./parser.ts";
export * from "./schemaVer.ts";
export * from "./parserRegistry.ts";
export * from "./parseStage.ts";
export { blindIndex, normalizeEmail } from "./blindIndex.ts";

// ── P3 AI extraction engine (09-ai-extraction-engine) ─────────────────────────────────────────────────
export * from "./extraction.ts";

export {
  registerBuiltinParsers,
  voyagerProfileParserV1,
  VOYAGER_PROFILE_ENDPOINT,
  VOYAGER_PROFILE_FINGERPRINT,
} from "./parsers/index.ts";

// ── P4 verification & approval workflow (10-verification-and-approval-workflow) ───────────────────────
export * from "./verification.ts";

// ── P5 entity resolution / dedup / merge / survivorship (ADR-0047; corpus ws06) ───────────────────────
export * from "./er.ts";

// ── P8 observability + hardening + performance (15 / 17 / 14) ─────────────────────────────────────────
export * from "./observability.ts";
export * from "./dsar.ts";
export * from "./capacity.ts";

// ── P9 legal sign-off + GA (14 §11, ADR-0046) ─────────────────────────────────────────────────────────
export * from "./ga.ts";

/** The review states a candidate can carry (exercises the core→types edge). */
export const REVIEW_STATES = reviewStatus.options;

/** Whether live capture is enabled (dark by default; exercises the core→config edge). */
export const CAPTURE_ENABLED = forgeFlags.captureEnabled;
