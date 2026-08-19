// connectorsFromEnv.test.ts — pins the credential plumbing (crm-sync 00 §10.5). The regression this
// guards: all three composition roots once built connectors with NO config, so `configured` was
// permanently false and the connect flow could never start. Env is injected — process.env untouched.

import { describe, expect, test } from "bun:test";
import { type CrmCredentialEnv, crmConnectorsFromEnv } from "./connectorsFromEnv.ts";

const EMPTY: CrmCredentialEnv = {
  CRM_HUBSPOT_CLIENT_ID: undefined,
  CRM_HUBSPOT_CLIENT_SECRET: undefined,
  CRM_SALESFORCE_CLIENT_ID: undefined,
  CRM_SALESFORCE_CLIENT_SECRET: undefined,
  CRM_OAUTH_REDIRECT_URI: undefined,
};

describe("crmConnectorsFromEnv", () => {
  test("no credentials → both providers present but unconfigured (connect refuses, boot never breaks)", () => {
    const connectors = crmConnectorsFromEnv(EMPTY);
    expect(connectors.hubspot?.configured).toBe(false);
    expect(connectors.salesforce?.configured).toBe(false);
  });

  test("a provider is configured only when BOTH its id and secret are set — independently per provider", () => {
    const connectors = crmConnectorsFromEnv({
      ...EMPTY,
      CRM_HUBSPOT_CLIENT_ID: "hs-id",
      CRM_HUBSPOT_CLIENT_SECRET: "hs-secret",
      CRM_OAUTH_REDIRECT_URI: "https://api.truepoint.in/api/v1/crm/callback",
    });
    expect(connectors.hubspot?.configured).toBe(true);
    expect(connectors.salesforce?.configured).toBe(false);
  });

  test("id without secret stays unconfigured (half-set env is a refusal, not a broken redirect)", () => {
    const connectors = crmConnectorsFromEnv({ ...EMPTY, CRM_SALESFORCE_CLIENT_ID: "sf-id" });
    expect(connectors.salesforce?.configured).toBe(false);
  });
});
