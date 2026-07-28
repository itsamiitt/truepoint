// Public surface of the CRM bidirectional-sync feature slice (crm-sync 00 §5.2 / §9).
// The webhook router is exported separately because it MUST be mounted before the authed one.
export { crmRoutes } from "./routes.ts";
export { crmWebhookRoutes } from "./webhookRoutes.ts";
