// connectorsFromEnv.ts — the ONE place the CRM connector set meets @leadwolf/config (crm-sync 00 §10.5).
//
// hubspot.ts / salesforce.ts stay env-free on purpose (pure DI — contract tests inject config + fixtures);
// this module closes the gap that made every deployed connector permanently `configured=false`: the api
// routes, the webhook receiver and the workers each called `defaultCrmConnectors()` BARE, so no credential
// ever reached an adapter and the connect flow could only throw "not configured". All three composition
// roots now build their set here, so the plumbing cannot drift between them.
//
// Credentials are the OAuth APP's client id/secret (our registered HubSpot/Salesforce app — not any
// tenant's token; those live encrypted in crm_connections). Absent env → that provider simply reports
// configured=false, which the connect route surfaces as a typed validation error.

import { env } from "@leadwolf/config";
import { defaultCrmConnectors } from "./hubspot.ts";

/** The slice of env this module reads — injectable so tests never mutate process.env. */
export type CrmCredentialEnv = Pick<
  typeof env,
  | "CRM_HUBSPOT_CLIENT_ID"
  | "CRM_HUBSPOT_CLIENT_SECRET"
  | "CRM_SALESFORCE_CLIENT_ID"
  | "CRM_SALESFORCE_CLIENT_SECRET"
  | "CRM_OAUTH_REDIRECT_URI"
>;

/** Build the provider→connector map from the deployment's credentials (defaults to the real env). */
export function crmConnectorsFromEnv(e: CrmCredentialEnv = env) {
  return defaultCrmConnectors({
    hubspot: {
      clientId: e.CRM_HUBSPOT_CLIENT_ID,
      clientSecret: e.CRM_HUBSPOT_CLIENT_SECRET,
      redirectUri: e.CRM_OAUTH_REDIRECT_URI,
    },
    salesforce: {
      clientId: e.CRM_SALESFORCE_CLIENT_ID,
      clientSecret: e.CRM_SALESFORCE_CLIENT_SECRET,
      redirectUri: e.CRM_OAUTH_REDIRECT_URI,
    },
  });
}
