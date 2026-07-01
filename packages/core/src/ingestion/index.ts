// Public surface of the unified ingestion connector framework (prospect-database-platform Phase 03 / I2).
export {
  type Connector,
  getConnector,
  registerConnector,
  registeredConnectorIds,
} from "./registry.ts";
export { registerBuiltinConnectors } from "./registerBuiltins.ts";
