// Barrel — exports only the routers (16 §6). Two of them, because the domain's reads hang off two different
// tenant resources: the company traversal addresses an account, the education traversal addresses a contact.
export { accountIntelligenceRoutes, contactIntelligenceRoutes } from "./routes.ts";
