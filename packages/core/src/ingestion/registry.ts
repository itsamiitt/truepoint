// registry.ts — the connector registry + the Connector PORT (prospect-database-platform Phase 03 / I2; audit
// P05/P06). A connector validates + maps ONE source's payload into the common raw-observation shape; everything
// after that (validate -> resolve -> enrich -> suppress -> land + evidence) is the SHARED pipeline (Phase 04), so
// dedup / suppression / scoring / evidence are identical regardless of source. The pipeline NEVER imports a
// concrete connector — it looks one up here by id, so adding a source is a register() call, never a pipeline
// change (mirrors apps/workers/register.ts's producer-registry style). ADDITIVE: registering a connector does not
// change the shipped import path; the re-route of runImport through the contract is a separate, flagged step.
import type { ConnectorId, IngestionEnvelope, RawObservation } from "@leadwolf/types";

/**
 * The port every ingestion source implements. `validateEnvelope` runs source-specific pre-checks (shape, consent
 * presence for capture sources, auth); throw to reject. `toRawObservations` maps the envelope's records into the
 * common raw-observation shape the shared pipeline consumes (verbatim-preserving).
 */
export interface Connector {
  id: ConnectorId;
  validateEnvelope(envelope: IngestionEnvelope): void;
  toRawObservations(envelope: IngestionEnvelope): RawObservation[];
}

const registry = new Map<ConnectorId, Connector>();

/** Register a connector (idempotent per id — a re-register replaces, so hot-reload / tests stay clean). */
export function registerConnector(connector: Connector): void {
  registry.set(connector.id, connector);
}

/** Look up a connector by id, or undefined if none is registered (the caller raises a clean 400/404). */
export function getConnector(id: ConnectorId): Connector | undefined {
  return registry.get(id);
}

/** The registered connector ids (diagnostics / the admin ingestion surface). */
export function registeredConnectorIds(): ConnectorId[] {
  return [...registry.keys()];
}
