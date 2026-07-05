// Public surface of the import feature slice — its routers.
export { importRoutes } from "./routes.ts";
// Bulk COPY-staging import (backlog #2, phase 6) — mounted at a more-specific prefix; gated dark behind
// BULK_IMPORT_ENABLED inside the router itself.
export { bulkImportRoutes } from "./bulkRoutes.ts";
// PII-bearing error-artifact download surface (import-redesign 10 §5 row 5 / 13 §4, S-V5/S-S4) — its own
// router (kept out of routes.ts) mounted at /api/v1/imports; the creator-∪-elevated gate is strict from birth.
export { importArtifactRoutes } from "./artifactRoutes.ts";
