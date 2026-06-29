// hubspot.ts — the HubSpot adapter IMPLEMENTING core's CrmConnector port (crm-sync §5.1). OAuth (auth-code
// exchange + refresh), a JSON client over the injectable CrmFetch (Bearer auth, pagination, the contacts /
// companies read + batch-upsert), the HubSpot error taxonomy + rate-limit parsing, and the HubSpot record ⇄
// our-model (id + properties) mapping. Mirrors createGoogleOAuthProvider: config (client id/secret/redirect)
// is INJECTED, never read from env, so the adapter never throws at construction and is unit-testable. No new
// dependency — global fetch + node:crypto only.

import { createHash, timingSafeEqual } from "node:crypto";
import type {
  CrmConnector,
  CrmFetch,
  CrmTokenBundle,
  CrmUpsertResult,
  CrmWebhookEvent,
} from "@leadwolf/core";
import type { CrmEnvironment, CrmObjectType, CrmProvider } from "@leadwolf/types";
import {
  CrmOAuthError,
  classifyHubspotStatus,
  defaultCrmFetch,
  formEncode,
  parseHubspotLimits,
} from "./hubspotHttp.ts";

const AUTH_ENDPOINT = "https://app.hubspot.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.hubapi.com/oauth/v1/token";
const API_BASE = "https://api.hubapi.com";
/** HubSpot has no `lead`/`deal` mapping in phase 1 — only contacts + companies. */
const OBJECT_PATH: Partial<Record<CrmObjectType, string>> = { contact: "contacts", account: "companies" };

export interface HubspotConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

interface HubspotRecord {
  id?: string | number;
  properties?: Record<string, unknown>;
}

const jsonHeaders = (bundle: CrmTokenBundle): Record<string, string> => ({
  authorization: `Bearer ${bundle.accessToken}`,
  "content-type": "application/json",
});

const mapRecord = (r: HubspotRecord) => ({
  externalId: String(r.id ?? ""),
  properties: r.properties ?? {},
});

/** The CRM record's modstamp drives the inbound watermark (valid-time). */
const modstamp = (r: HubspotRecord): string | undefined => {
  const v = r.properties?.hs_lastmodifieddate;
  return typeof v === "string" ? v : undefined;
};

/** Map a HubSpot webhook `subscriptionType` prefix onto our object kind (drop unknown types). */
function objectForSubscription(sub: string): CrmObjectType | undefined {
  if (sub.startsWith("contact.")) return "contact";
  if (sub.startsWith("company.")) return "account";
  return undefined;
}

function toBundle(
  status: number,
  json: unknown,
  carryRefresh: string | undefined,
  env: CrmEnvironment,
): CrmTokenBundle {
  const body = (json ?? {}) as { access_token?: string; refresh_token?: string; expires_in?: number; message?: string };
  if (status !== 200 || typeof body.access_token !== "string") {
    throw new CrmOAuthError("invalid_grant", body.message ?? `HubSpot token endpoint returned ${status}`, status);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? carryRefresh,
    expiresAt: Date.now() + (body.expires_in ?? 1800) * 1000,
    scopes: [],
    apiBaseUrl: API_BASE,
    environment: env,
  };
}

/** Build the HubSpot connector. `fetch` is the default transport; each method may override it per call. */
export function hubspotConnector(config: HubspotConfig = {}, fetch: CrmFetch = defaultCrmFetch): CrmConnector {
  const configured = Boolean(config.clientId && config.clientSecret);

  async function tokenCall(f: CrmFetch, form: Record<string, string>, env: CrmEnvironment, carry?: string) {
    const { status, json } = await f({
      method: "POST",
      url: TOKEN_ENDPOINT,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formEncode(form),
    });
    return toBundle(status, json, carry, env);
  }

  /** Run a JSON data-plane call and wrap it in a CrmOutcome (ok | the classified error variant). */
  async function call<T>(
    f: CrmFetch,
    req: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; bundle: CrmTokenBundle; body?: unknown },
    value: (json: unknown) => T,
  ) {
    const { status, headers, json } = await f({ method: req.method, url: req.url, headers: jsonHeaders(req.bundle), body: req.body });
    const err = classifyHubspotStatus(status, headers, json);
    if (err) return err;
    return { kind: "ok" as const, value: value(json), limits: parseHubspotLimits(status, headers, json) };
  }

  const pathFor = (object: CrmObjectType) => OBJECT_PATH[object];

  return {
    provider: "hubspot",
    configured,

    buildAuthorizeUrl({ state, redirectUri, scopes }) {
      const q = new URLSearchParams({
        client_id: config.clientId ?? "",
        redirect_uri: redirectUri,
        scope: scopes.join(" "),
        state,
      });
      return `${AUTH_ENDPOINT}?${q.toString()}`; // HubSpot is a confidential client — no PKCE challenge
    },

    exchangeCode({ code, redirectUri, env }, f = fetch) {
      return tokenCall(
        f,
        { grant_type: "authorization_code", client_id: config.clientId ?? "", client_secret: config.clientSecret ?? "", redirect_uri: redirectUri, code },
        env,
      );
    },

    refresh(bundle, f = fetch) {
      return tokenCall(
        f,
        { grant_type: "refresh_token", client_id: config.clientId ?? "", client_secret: config.clientSecret ?? "", refresh_token: bundle.refreshToken ?? "" },
        bundle.environment,
        bundle.refreshToken,
      );
    },

    testConnection(bundle, f = fetch) {
      return call(f, { method: "GET", url: `${API_BASE}/account-info/v3/details`, bundle }, (json) => {
        const j = (json ?? {}) as { portalId?: number; companyName?: string };
        return { account: String(j.companyName ?? j.portalId ?? "hubspot"), environment: bundle.environment };
      });
    },

    pullPage({ bundle, object, cursor, pageSize }, f = fetch) {
      const path = pathFor(object);
      if (!path) return Promise.resolve({ kind: "validation" as const, detail: `unsupported object ${object}` });
      const after = cursor ? `&after=${encodeURIComponent(cursor)}` : "";
      return call(
        f,
        { method: "GET", url: `${API_BASE}/crm/v3/objects/${path}?limit=${pageSize}&archived=false&properties=hs_lastmodifieddate${after}`, bundle },
        (json) => {
          const j = (json ?? {}) as { results?: HubspotRecord[]; paging?: { next?: { after?: string } } };
          const results = j.results ?? [];
          return {
            records: results.map(mapRecord),
            nextCursor: j.paging?.next?.after,
            highWatermark: results.length > 0 ? modstamp(results[results.length - 1]) : undefined,
          };
        },
      );
    },

    pullDelta({ bundle, object, sinceWatermark, pageSize }, f = fetch) {
      const path = pathFor(object);
      if (!path) return Promise.resolve({ kind: "validation" as const, detail: `unsupported object ${object}` });
      const body = {
        filterGroups: [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: sinceWatermark }] }],
        sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
        properties: ["hs_lastmodifieddate"],
        limit: pageSize,
      };
      return call(f, { method: "POST", url: `${API_BASE}/crm/v3/objects/${path}/search`, bundle, body }, (json) => {
        const results = ((json ?? {}) as { results?: HubspotRecord[] }).results ?? [];
        return {
          records: results.map(mapRecord),
          highWatermark: results.length > 0 ? (modstamp(results[results.length - 1]) ?? sinceWatermark) : sinceWatermark,
        };
      });
    },

    fetchOne({ bundle, object, externalId }, f = fetch) {
      const path = pathFor(object);
      if (!path) return Promise.resolve({ kind: "validation" as const, detail: `unsupported object ${object}` });
      return call(
        f,
        { method: "GET", url: `${API_BASE}/crm/v3/objects/${path}/${encodeURIComponent(externalId)}?archived=false&properties=hs_lastmodifieddate`, bundle },
        (json) => ({ record: json === null ? null : mapRecord(json as HubspotRecord) }),
      );
    },

    upsert({ bundle, object, externalIdField, records }, f = fetch) {
      const path = pathFor(object);
      if (!path) return Promise.resolve({ kind: "validation" as const, detail: `unsupported object ${object}` });
      // HubSpot caps a batch upsert at 100 inputs — the runner batches; the adapter sends what it is given.
      const inputs = records.map((r) => ({ idProperty: externalIdField, id: r.externalId, properties: r.values }));
      return call(f, { method: "POST", url: `${API_BASE}/crm/v3/objects/${path}/batch/upsert`, bundle, body: { inputs } }, (json) => {
        const results = ((json ?? {}) as { results?: HubspotRecord[] }).results ?? [];
        const perRecord: CrmUpsertResult[] = records.map((r, i) => ({
          externalId: r.externalId,
          outcome: results[i] ? "updated" : "rejected",
        }));
        return { perRecord };
      });
    },

    eraseOrSuppress({ bundle, object, externalId, mode }, f = fetch) {
      const path = pathFor(object);
      if (!path) return Promise.resolve({ kind: "validation" as const, detail: `unsupported object ${object}` });
      if (mode === "gdpr_delete" && path === "contacts") {
        return call(f, { method: "POST", url: `${API_BASE}/crm/v3/objects/contacts/gdpr-delete`, bundle, body: { objectId: externalId } }, () => undefined);
      }
      return call(f, { method: "DELETE", url: `${API_BASE}/crm/v3/objects/${path}/${encodeURIComponent(externalId)}`, bundle }, () => undefined);
    },

    verifyWebhook(raw, headers, secret) {
      // HubSpot v1: sha256(clientSecret + requestBody), hex, compared timing-safe. The v3 check (which also
      // binds method + URI + timestamp) is completed at the route, where those inputs are available.
      const provided = headers["x-hubspot-signature"] ?? headers["X-HubSpot-Signature"];
      if (!provided) return false;
      const expected = createHash("sha256").update(secret + raw, "utf8").digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(provided);
      return a.length === b.length && timingSafeEqual(a, b);
    },

    parseWebhookEnvelope(raw) {
      let events: unknown;
      try {
        events = JSON.parse(raw);
      } catch {
        return [];
      }
      if (!Array.isArray(events)) return [];
      const out: CrmWebhookEvent[] = [];
      for (const e of events) {
        const ev = (e ?? {}) as { objectId?: unknown; subscriptionType?: unknown; eventId?: unknown; sourceId?: unknown };
        const sub = typeof ev.subscriptionType === "string" ? ev.subscriptionType : "";
        const object = objectForSubscription(sub);
        if (!object || ev.objectId === undefined) continue;
        out.push({ object, externalId: String(ev.objectId), eventId: String(ev.eventId ?? ev.objectId), sourceTag: String(ev.sourceId ?? "") });
      }
      return out;
    },

    parseLimits(status, headers, body) {
      return parseHubspotLimits(status, headers, body);
    },
  };
}

/** The configured connector set — mirrors defaultProviders(); salesforce is the deferred fast-follow. */
export function defaultCrmConnectors(config: { hubspot?: HubspotConfig } = {}): Partial<Record<CrmProvider, CrmConnector>> {
  return { hubspot: hubspotConnector(config.hubspot) };
}
