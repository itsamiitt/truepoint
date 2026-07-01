// registerBuiltins.ts — register the built-in ingestion connectors (prospect-database-platform Phase 03 / I2).
// Called once at the app composition root (apps/api boot). Idempotent — a re-call is a no-op, so hot-reload/tests
// stay clean. New built-in connectors (chrome_extension, enrichment, …) are added here as their slices land.
import { adminUploadConnector } from "./connectors/adminUpload.ts";
import { registerConnector } from "./registry.ts";

let registered = false;

export function registerBuiltinConnectors(): void {
  if (registered) return;
  registerConnector(adminUploadConnector);
  registered = true;
}
