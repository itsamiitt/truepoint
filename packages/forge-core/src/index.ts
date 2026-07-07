// @leadwolf/forge-core — the TruePoint Forge factory brain, nested in the monorepo (docs/planning/forge/04,
// re-homed from @forge/core): the raw→parsed→verified pipeline stages (ingest/parse/extract/verify), the
// Fellegi-Sunter ER + survivorship, quality/validation, DSAR + GA gates, and the ports the integrations
// adapters implement. Reuses @leadwolf/{types,config,db}; never imports @leadwolf/integrations (a core layer).
// Ported stage-by-stage in P2. This barrel is the sole public surface.
export const FORGE_CORE_VERSION = "0.0.0";
