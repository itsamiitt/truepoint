// salesforce.ts — the Salesforce adapter IMPLEMENTING core's CrmConnector port (crm-sync §5.1), mirroring
// hubspot.ts EXACTLY: OAuth (auth-code + PKCE exchange + refresh — SFDC returns an `instance_url` we persist
// in the bundle), a JSON client over the injectable CrmFetch (Bearer auth, SOQL query pagination, sObject
// Collections upsert by external id), the SFDC error taxonomy + `Sforce-Limit-Info` rate parsing, and the
// SFDC sObject ⇄ our-model (Id + properties) mapping. Like createGoogleOAuthProvider / hubspotConnector,
// client id/secret are INJECTED (never read from env) so the adapter never throws at construction and is
// unit-testable on recorded fixtures. No new dependency — global fetch only (via ./hubspotHttp.ts).

import type { CrmConnector, CrmFetch, CrmTokenBundle, CrmUpsertResult } from "@leadwolf/core";
import type { CrmEnvironment, CrmObjectType } from "@leadwolf/types";
import { CrmOAuthError, defaultCrmFetch, formEncode } from "./hubspotHttp.ts";
import { classifySalesforceStatus, parseSalesforceLimits } from "./salesforceHttp.ts";

const PROD_LOGIN = "https://login.salesforce.com";
const SANDBOX_LOGIN = "https://test.salesforce.com";
const API_VERSION = "v61.0";
/** SFDC has no `deal` SObject in phase 1 — Opportunity is reserved; contact/account/lead are mapped. */
const SOBJECT: Partial<Record<CrmObjectType, string>> = {
  contact: "Contact",
  account: "Account",
  lead: "Lead",
};
/** §7.6 anonymize set per object: scrub identifying PII + raise Do-Not-Contact (required fields → "Redacted"). */
const ANONYMIZE: Partial<Record<CrmObjectType, Record<string, unknown>>> = {
  contact: { FirstName: "Redacted", LastName: "Redacted", Email: null, Phone: null, MobilePhone: null, HasOptedOutOfEmail: true, DoNotCall: true },
  lead: { FirstName: "Redacted", LastName: "Redacted", Company: "Redacted", Email: null, Phone: null, MobilePhone: null, HasOptedOutOfEmail: true, DoNotCall: true },
  account: { Name: "Redacted", Phone: null, Website: null },
};

export interface SalesforceConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

interface SfRecord {
  Id?: string;
  SystemModstamp?: string;
  attributes?: { type?: string; url?: string };
  [key: string]: unknown;
}

const loginHost = (env: CrmEnvironment): string => (env === "sandbox" ? SANDBOX_LOGIN : PROD_LOGIN);
const apiBase = (bundle: CrmTokenBundle): string => `${bundle.instanceUrl}/services/data/${API_VERSION}`;
const pathFor = (object: CrmObjectType): string | undefined => SOBJECT[object];
const anonymizeValues = (object: CrmObjectType): Record<string, unknown> => ANONYMIZE[object] ?? {};
const hasDnc = (object: CrmObjectType): boolean => object === "contact" || object === "lead";

const jsonHeaders = (bundle: CrmTokenBundle): Record<string, string> => ({
  authorization: `Bearer ${bundle.accessToken}`,
  "content-type": "application/json",
});

/** Drop SFDC's `attributes` envelope; keep the record Id as the external id (the modstamp drives watermarks). */
const mapRecord = (r: SfRecord) => {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k !== "attributes") properties[k] = v;
  }
  return { externalId: String(r.Id ?? ""), properties };
};

/** Accepts `undefined` so an out-of-range index access (noUncheckedIndexedAccess) is safe at the call site. */
const modstamp = (r: SfRecord | undefined): string | undefined =>
  typeof r?.SystemModstamp === "string" ? r.SystemModstamp : undefined;

/** Per-record SaveResult → our outcome (success+created → created; success → updated; else rejected). */
const outcomeFor = (res?: { success?: boolean; created?: boolean }): CrmUpsertResult["outcome"] => {
  if (!res?.success) return "rejected";
  return res.created ? "created" : "updated";
};

function toBundle(
  status: number,
  json: unknown,
  carryRefresh: string | undefined,
  env: CrmEnvironment,
): CrmTokenBundle {
  const body = (json ?? {}) as {
    access_token?: string;
    refresh_token?: string;
    instance_url?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (status !== 200 || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : "invalid_grant";
    const msg = body.error_description ?? `Salesforce token endpoint returned ${status}`;
    throw new CrmOAuthError(code, msg, status);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? carryRefresh,
    expiresAt: 0, // SFDC issues no expires_in → refresh REACTIVELY on auth_expired (INVALID_SESSION_ID)
    scopes: typeof body.scope === "string" ? body.scope.split(" ") : [],
    instanceUrl: typeof body.instance_url === "string" ? body.instance_url : undefined,
    environment: env,
  };
}

/** Build the Salesforce connector. `fetch` is the default transport; each method may override it per call. */
export function salesforceConnector(
  config: SalesforceConfig = {},
  fetch: CrmFetch = defaultCrmFetch,
): CrmConnector {
  const configured = Boolean(config.clientId && config.clientSecret);

  async function tokenCall(f: CrmFetch, form: Record<string, string>, env: CrmEnvironment, carry?: string) {
    const { status, json } = await f({
      method: "POST",
      url: `${loginHost(env)}/services/oauth2/token`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formEncode(form),
    });
    return toBundle(status, json, carry, env);
  }

  /** Run a JSON data-plane call and wrap it in a CrmOutcome (ok | the classified error variant). */
  async function call<T>(
    f: CrmFetch,
    req: {
      method: "GET" | "POST" | "PATCH" | "DELETE";
      url: string;
      bundle: CrmTokenBundle;
      body?: unknown;
      headers?: Record<string, string>;
    },
    value: (json: unknown) => T,
  ) {
    const headers = { ...jsonHeaders(req.bundle), ...req.headers };
    const { status, headers: res, json } = await f({ method: req.method, url: req.url, headers, body: req.body });
    const err = classifySalesforceStatus(status, res, json);
    if (err) return err;
    return { kind: "ok" as const, value: value(json), limits: parseSalesforceLimits(status, res, json) };
  }

  return {
    provider: "salesforce",
    configured,

    buildAuthorizeUrl({ state, codeChallenge, redirectUri, scopes, env }) {
      const q = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId ?? "",
        redirect_uri: redirectUri,
        scope: scopes.join(" "),
        state,
        code_challenge: codeChallenge, // SFDC is a PKCE client (unlike HubSpot's confidential flow)
        code_challenge_method: "S256",
      });
      return `${loginHost(env)}/services/oauth2/authorize?${q.toString()}`;
    },

    exchangeCode({ code, codeVerifier, redirectUri, env }, f = fetch) {
      return tokenCall(
        f,
        { grant_type: "authorization_code", client_id: config.clientId ?? "", client_secret: config.clientSecret ?? "", redirect_uri: redirectUri, code, code_verifier: codeVerifier },
        env,
      );
    },

    refresh(bundle, f = fetch) {
      return tokenCall(
        f,
        { grant_type: "refresh_token", client_id: config.clientId ?? "", client_secret: config.clientSecret ?? "", refresh_token: bundle.refreshToken ?? "" },
        bundle.environment,
        bundle.refreshToken, // SFDC refresh does not rotate the refresh token — carry it forward
      );
    },

    testConnection(bundle, f = fetch) {
      // GET /limits doubles as the daily-API-cap probe (§5.4).
      return call(f, { method: "GET", url: `${apiBase(bundle)}/limits`, bundle }, (json) => {
        const j = (json ?? {}) as { DailyApiRequests?: { Max?: number; Remaining?: number } };
        const max = j.DailyApiRequests?.Max;
        const remaining = j.DailyApiRequests?.Remaining;
        const daily =
          typeof max === "number" && typeof remaining === "number"
            ? { used: max - remaining, max }
            : undefined;
        return { account: bundle.instanceUrl ?? "salesforce", environment: bundle.environment, daily };
      });
    },

    pullPage({ bundle, object, cursor, pageSize }, f = fetch) {
      const sobject = pathFor(object);
      if (!sobject) return Promise.resolve({ kind: "validation" as const, detail: `unsupported object ${object}` });
      const soql = `SELECT Id, SystemModstamp FROM ${sobject} ORDER BY SystemModstamp ASC`;
      const url = cursor ? `${bundle.instanceUrl}${cursor}` : `${apiBase(bundle)}/query?q=${encodeURIComponent(soql)}`;
      return call(
        f,
        { method: "GET", url, bundle, headers: { "sforce-query-options": `batchSize=${pageSize}` } },
        (json) => {
          const j = (json ?? {}) as { records?: SfRecord[]; nextRecordsUrl?: string; done?: boolean };
          const records = j.records ?? [];
          return {
            records: records.map(mapRecord),
            nextCursor: j.done === false ? j.nextRecordsUrl : undefined,
            highWatermark: records.length > 0 ? modstamp(records[records.length - 1]) : undefined,
          };
        },
      );
    },

    pullDelta({ bundle, object, sinceWatermark, pageSize }, f = fetch) {
      const sobject = pathFor(object);
      if (!sobject) return Promise.resolve({ kind: "validation" as const, detail: `unsupported object ${object}` });
      // SOQL datetime literals are unquoted; sinceWatermark is our own stored SystemModstamp (system-owned).
      const soql = `SELECT Id, SystemModstamp FROM ${sobject} WHERE SystemModstamp > ${sinceWatermark} ORDER BY SystemModstamp ASC`;
      return call(
        f,
        { method: "GET", url: `${apiBase(bundle)}/query?q=${encodeURIComponent(soql)}`, bundle, headers: { "sforce-query-options": `batchSize=${pageSize}` } },
        (json) => {
          const records = ((json ?? {}) as { records?: SfRecord[] }).records ?? [];
          return {
            records: records.map(mapRecord),
            highWatermark: records.length > 0 ? (modstamp(records[records.length - 1]) ?? sinceWatermark) : sinceWatermark,
          };
        },
      );
    },

    fetchOne({ bundle, object, externalId }, f = fetch) {
      const sobject = pathFor(object);
      if (!sobject) return Promise.resolve({ kind: "validation" as const, detail: `unsupported object ${object}` });
      return call(
        f,
        { method: "GET", url: `${apiBase(bundle)}/sobjects/${sobject}/${encodeURIComponent(externalId)}`, bundle },
        (json) => ({ record: json === null ? null : mapRecord(json as SfRecord) }),
      );
    },

    upsert({ bundle, object, externalIdField, records }, f = fetch) {
      const sobject = pathFor(object);
      if (!sobject) return Promise.resolve({ kind: "validation" as const, detail: `unsupported object ${object}` });
      // sObject Collections upsert by external id (≤200 rows; the runner batches). The `truepoint_id__c`
      // external-id custom field is a CONNECT-TIME PREREQ on each mapped SObject.
      const body = {
        allOrNone: false,
        records: records.map((r) => ({ attributes: { type: sobject }, [externalIdField]: r.externalId, ...r.values })),
      };
      const url = `${apiBase(bundle)}/composite/sobjects/${sobject}/${encodeURIComponent(externalIdField)}`;
      return call(f, { method: "PATCH", url, bundle, body }, (json) => {
        const results = Array.isArray(json) ? (json as Array<{ success?: boolean; created?: boolean }>) : [];
        const perRecord: CrmUpsertResult[] = records.map((r, i) => ({ externalId: r.externalId, outcome: outcomeFor(results[i]) }));
        return { perRecord };
      });
    },

    async eraseOrSuppress({ bundle, object, externalId, mode }, f = fetch) {
      const sobject = pathFor(object);
      if (!sobject) return { kind: "validation" as const, detail: `unsupported object ${object}` };
      const url = `${apiBase(bundle)}/sobjects/${sobject}/${encodeURIComponent(externalId)}`;
      const anonymize = () =>
        call(f, { method: "PATCH", url, bundle, body: anonymizeValues(object) }, () => ({
          path: "anonymized" as const,
          doNotContact: hasDnc(object),
        }));
      if (mode === "anonymize") return anonymize();

      // delete/gdpr_delete → attempt the hard delete; SFDC has NO GDPR endpoint, so a refused delete falls
      // back to anonymize + Do-Not-Contact (§7.6). The outcome ALWAYS names which path actually ran.
      const del = await call(f, { method: "DELETE", url, bundle }, () => ({ path: "deleted" as const }));
      if (del.kind === "ok") return del;
      if (del.kind === "not_found") return { kind: "ok" as const, value: { path: "deleted" as const }, limits: {} };
      // Retryable failures must NOT silently downgrade to anonymize — let the worker retry/refresh.
      if (del.kind === "transient" || del.kind === "rate_limited" || del.kind === "auth_expired" || del.kind === "auth_revoked") {
        return del;
      }
      // validation / permanent / conflict → the org will not let us delete → anonymize + DNC instead.
      return anonymize();
    },

    verifyWebhook() {
      // Phase-1 Salesforce is POLLING-ONLY: change capture is the SystemModstamp delta/reconcile poll. CDC /
      // Platform Events need a CometD / Pub-Sub (gRPC) streaming client (extra infra) — deferred. No inbound
      // HTTP webhook is trusted (fail-closed), so this always reports unverified.
      return false;
    },

    parseWebhookEnvelope() {
      return []; // polling-only — no webhook envelope to parse in phase 1 (see verifyWebhook).
    },

    parseLimits(status, headers, body) {
      return parseSalesforceLimits(status, headers, body);
    },
  };
}
