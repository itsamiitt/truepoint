// Public surface of the api-keys feature slice — machine API credential management (09 §4, ADR-0049).
// Mounted at /api/v1/tenants/me/api-keys in app.ts, which is the path apps/web's Settings ▸ Developer panel
// has been calling since M10. Gated by the security_admin org role (ADR-0030), not a workspace role.
export { apiKeyRoutes } from "./routes.ts";
// Usage is a separate router because it is a separate authorization question: reading spend is ordinary
// workspace visibility, while minting a credential is a security_admin duty.
export { apiUsageRoutes } from "./usageRoutes.ts";
