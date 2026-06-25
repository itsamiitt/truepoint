// Public surface of the SCIM feature slice — the SCIM 2.0 /Users provisioning/deprovisioning router an org's
// IdP calls with a `scim_tokens` bearer token (enterprise IAM, 17 / ADR-0018). Mounted at /scim/v2 in app.ts,
// disjoint from /api/v1; it carries its OWN bearer-token auth (scimAuth) and SCIM error envelope.
export { scimUserRoutes } from "./userRoutes.ts";
