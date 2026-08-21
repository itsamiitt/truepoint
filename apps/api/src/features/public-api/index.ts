// Public surface of the public-api feature slice — the machine-authenticated data API (ADR-0049).
//
// Mounted at /api/v1/public in app.ts, behind PUBLIC_DATA_API_ENABLED (while off the router is not mounted
// and the paths 404 — the MASTER_SYNC_INGRESS_ENABLED posture, which is the right one for a surface that
// authenticates a machine credential and spends a tenant's credits).
//
// Only the COMPANY endpoints exist. Person and search are blocked on a compliance precondition, not on
// effort: a public read of the person graph has no suppression_list coverage (see companyRoutes.ts and
// ADR-0049 §Open).
export { publicCompanyRoutes } from "./companyRoutes.ts";
export { apiKeyAuth, requireScope, type PublicApiVariables } from "./apiKeyAuth.ts";
