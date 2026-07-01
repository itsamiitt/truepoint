// registerBuiltins.ts — register the built-in ingestion connectors (prospect-database-platform Phase 03 / I2).
// Called once at the app composition root (apps/api boot). Idempotent — a re-call is a no-op, so hot-reload/tests
// stay clean. New built-in connectors (chrome_extension, enrichment, …) are added here as their slices land.
import { env } from "@leadwolf/config";
import { adminUploadConnector } from "./connectors/adminUpload.ts";
import { chromeExtensionConnector } from "./connectors/chromeExtension.ts";
import { registerConnector } from "./registry.ts";

let registered = false;

export function registerBuiltinConnectors(): void {
  if (registered) return;
  registerConnector(adminUploadConnector);
  // Chrome-extension capture (I6) — a SCRAPING source, registered ONLY when CHROME_EXTENSION_ENABLED is on (legal
  // sign-off). While off it is NOT registered, so POST /api/v1/ingest returns 400 'no connector' for
  // chrome_extension and nothing is captured. The connector hard-gates consent/ToS on every envelope.
  if (env.CHROME_EXTENSION_ENABLED) {
    registerConnector(chromeExtensionConnector);
  }
  registered = true;
}
