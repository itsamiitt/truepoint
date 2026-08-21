// Public surface of the api-keys feature slice — machine API credential management (09 §4, ADR-0049).
// Mounted at /api/v1/tenants/me/api-keys in app.ts, which is the path apps/web's Settings ▸ Developer panel
// has been calling since M10. Gated by the security_admin org role (ADR-0030), not a workspace role.
export { apiKeyRoutes } from "./routes.ts";
