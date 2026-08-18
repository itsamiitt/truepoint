// providers.ts — the vendor adapters (06 §3): Apollo, ZoomInfo, Clearbit (first wave) + PDL, Coresignal
// (waterfall v2 / 0111), each a VendorSpec over the shared httpProvider shape. Endpoint payload mappings
// follow each vendor's person-enrich API; trust/cost are static waterfall inputs (hit-rate learning lands
// with telemetry, 06 §4). Keys come from config; an absent key → permanent `miss` (the adapter never
// throws on configuration) — which is also the COMPLIANCE enforcement: PDL/Coresignal ship dark until
// their DPA + sub-processor listing + ToS review are recorded and only then get a production key
// (08-compliance §10, 21 §4/§5).

import { env } from "@leadwolf/config";
import type { EnrichRequest, EnrichmentProvider, ProviderResult } from "@leadwolf/core";
import { fetchLinkedinProfile } from "@leadwolf/core";
import type { EnrichField } from "@leadwolf/types";
import { type FetchJson, vendorProvider } from "./httpProvider.ts";
import { zoominfoToken } from "./zoominfoAuth.ts";

type Extracted = Partial<Record<EnrichField, string>>;

const pick = (obj: Record<string, unknown>, key: string): string | undefined => {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

function extractFlat(
  json: unknown,
  root: string,
  map: Record<EnrichField, string>,
  fields: EnrichField[],
): Extracted {
  if (typeof json !== "object" || json === null) return {};
  const container = (json as Record<string, unknown>)[root];
  if (typeof container !== "object" || container === null) return {};
  const record = container as Record<string, unknown>;
  const out: Extracted = {};
  for (const field of fields) {
    const value = pick(record, map[field]);
    if (value) out[field] = value;
  }
  return out;
}

const FIELD_MAP: Record<EnrichField, string> = {
  email: "email",
  phone: "phone",
  jobTitle: "title",
  seniorityLevel: "seniority",
  department: "department",
};

export function apolloProvider(fetchJson?: FetchJson): EnrichmentProvider {
  return vendorProvider(
    {
      name: "apollo",
      trust: 0.8,
      costMicrosPerCall: 30_000, // $0.03 — placeholder unit cost; tuned from provider telemetry
      url: "https://api.apollo.io/v1/people/match",
      apiKey: env.APOLLO_API_KEY,
      headers: (key) => ({ "x-api-key": key }),
      body: (req) => ({
        email: req.subject.email,
        name: req.subject.fullName,
        organization_domain: req.subject.companyDomain,
        linkedin_url: req.subject.linkedinUrl,
      }),
      extract: (json, fields) => extractFlat(json, "person", FIELD_MAP, fields),
    },
    fetchJson,
  );
}

/** ZoomInfo's own field names, which do not match the generic FIELD_MAP: seniority is `managementLevel`
 *  (an array), department comes from `jobFunction`, and the mobile number is a separate field. */
const ZOOMINFO_FIELD_MAP: Record<EnrichField, string> = {
  email: "email",
  phone: "phone",
  jobTitle: "jobTitle",
  seniorityLevel: "managementLevel",
  department: "jobFunction",
};

/** The `outputFields` ZoomInfo will return. Required by the API and requested explicitly — ZoomInfo
 *  returns only what is asked for, and every returned record is billable, so we ask for exactly what the
 *  waterfall can store. */
const ZOOMINFO_OUTPUT_FIELDS = [
  "id",
  "firstName",
  "lastName",
  "email",
  "phone",
  "mobilePhone",
  "jobTitle",
  "jobFunction",
  "managementLevel",
  "companyName",
  "companyId",
] as const;

/** GTM contact enrich (docs.zoominfo.com/reference/enrichinterface_enrichcontact). Max 25 inputs/request;
 *  we send one, because the waterfall enriches one subject at a time. */
const ZOOMINFO_ENRICH_URL = "https://api.zoominfo.com/gtm/data/v1/contacts/enrich";

/** EnrichSubject carries only `fullName`; ZoomInfo matches better on the split pair, so derive it —
 *  first token / remainder, which is all a single display string can honestly support. */
function splitFullName(fullName: string | undefined): [string | undefined, string | undefined] {
  const parts = fullName?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return [undefined, undefined];
  if (parts.length === 1) return [parts[0], undefined];
  return [parts[0], parts.slice(1).join(" ")];
}

/** A ZoomInfo value may be a string, an array (managementLevel), or an object (jobFunction). Narrow all
 *  three to a single string — the payload is untrusted input and only strings may reach storage. */
function zoominfoValue(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((v) => typeof v === "string" && v.length > 0);
    if (typeof first === "string") return first;
    const nested = raw.find((v) => typeof v === "object" && v !== null);
    if (nested) return zoominfoValue(nested);
    return undefined;
  }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    // jobFunction arrives as { name, department } — the department is the field we store.
    return zoominfoValue(obj.department ?? obj.name ?? obj.value);
  }
  return undefined;
}

/**
 * Pull the matched record out of a ZoomInfo enrich response. Two shapes are accepted deliberately: the
 * Enterprise API answers `data.result[].data[]` with a sibling `matchStatus`, while the newer documented
 * shape is a JSON:API-style `data[].attributes` with `meta.matchStatus`. Supporting both means a vendor-side
 * migration does not silently zero our hit rate (the envelope lesson from the linkedin_api lane).
 * A non-match is treated as no fields — a paid miss, which is exactly what it is.
 */
export function extractZoominfo(
  json: unknown,
  fields: EnrichField[],
): Partial<Record<EnrichField, string>> {
  if (typeof json !== "object" || json === null) return {};
  const root = json as Record<string, unknown>;

  let record: Record<string, unknown> | undefined;
  let matchStatus: string | undefined;

  const data = root.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    // Enterprise: { data: { result: [ { data: [ {...} ], matchStatus } ] } }
    const result = (data as Record<string, unknown>).result;
    const first = Array.isArray(result) ? result[0] : undefined;
    if (typeof first === "object" && first !== null) {
      const entry = first as Record<string, unknown>;
      matchStatus = typeof entry.matchStatus === "string" ? entry.matchStatus : undefined;
      const inner = entry.data;
      const one = Array.isArray(inner) ? inner[0] : inner;
      if (typeof one === "object" && one !== null) record = one as Record<string, unknown>;
    }
  } else if (Array.isArray(data)) {
    // GTM: { data: [ { type: "Contact" | "NoMatch", attributes: {...}, meta: { matchStatus } } ] }
    const first = data.find((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      return (entry as Record<string, unknown>).type !== "NoMatch";
    });
    if (typeof first === "object" && first !== null) {
      const entry = first as Record<string, unknown>;
      const attrs = entry.attributes;
      if (typeof attrs === "object" && attrs !== null) record = attrs as Record<string, unknown>;
      const meta = entry.meta as Record<string, unknown> | undefined;
      if (meta && typeof meta.matchStatus === "string") matchStatus = meta.matchStatus;
    }
  }

  if (!record) return {};
  // ALLOWLIST the statuses that mean "this is the person you asked for". ZoomInfo also answers NO_MATCH,
  // NON_MATCH_BY_REQUIRED_FIELDS, OPT_OUT and LIMIT_EXCEEDED — a denylist would have to stay in sync with
  // that vocabulary forever, and the failure mode of guessing wrong is another person's contact details
  // landing on this record.
  if (matchStatus !== undefined && !/(^|_)(FULL|PARTIAL)_MATCH$/.test(matchStatus.toUpperCase())) {
    return {};
  }

  const out: Partial<Record<EnrichField, string>> = {};
  for (const field of fields) {
    // Phone: prefer the direct dial, fall back to mobile — S-04 wants a number that reaches a human.
    const value =
      field === "phone"
        ? (zoominfoValue(record.phone) ?? zoominfoValue(record.mobilePhone))
        : zoominfoValue(record[ZOOMINFO_FIELD_MAP[field]]);
    if (value) out[field] = value;
  }
  return out;
}

/**
 * The GTM enrich request body — a JSON:API envelope: `data.type = "ContactEnrich"` wrapping the match
 * batch and the requested output fields. Exported so the shape is testable without credentials, which is
 * the normal state in CI (the provider short-circuits to a miss when ZoomInfo is unconfigured).
 *
 * `requiredFields` is deliberately NOT sent: it makes ZoomInfo withhold a record that lacks the named
 * field, and the waterfall would rather see a partial record — one verified mobile is worth more than a
 * suppressed row (S-04).
 */
export function zoominfoMatchBody(req: EnrichRequest): {
  data: {
    type: "ContactEnrich";
    attributes: {
      matchPersonInput: Array<Record<string, string | undefined>>;
      outputFields: string[];
    };
  };
} {
  const [firstName, lastName] = splitFullName(req.subject.fullName);
  return {
    data: {
      type: "ContactEnrich",
      attributes: {
        matchPersonInput: [
          {
            emailAddress: req.subject.email,
            firstName,
            lastName,
            fullName: req.subject.fullName,
            companyName: req.subject.companyName ?? req.subject.companyDomain,
            externalURL: req.subject.linkedinUrl,
          },
        ],
        outputFields: [...ZOOMINFO_OUTPUT_FIELDS],
      },
    },
  };
}

/**
 * Request headers for GTM enrich. The gateway REFUSES `accept: application/json` with a 406 — verified
 * live against the endpoint — because it is a JSON:API surface and wants the JSON:API media type. Exported
 * so that stays under test: the 406 is invisible in CI, where the provider never authenticates.
 */
export function zoominfoHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: "application/vnd.api+json" };
}

/**
 * ZoomInfo contact enrich, on the GTM API. Unlike every other adapter here the credential is a MINTED
 * token (zoominfoAuth: client-credentials → Bearer access_token), not a static key. The match input is
 * sent best-first: a verified email or a LinkedIn URL is what lifts ZoomInfo's match rate, and
 * `externalURL` is where a LinkedIn profile belongs.
 */
export function zoominfoProvider(fetchJson?: FetchJson): EnrichmentProvider {
  return vendorProvider(
    {
      name: "zoominfo",
      trust: 0.85,
      costMicrosPerCall: 60_000,
      url: ZOOMINFO_ENRICH_URL,
      // Static key is only the pre-minted escape hatch; the resolver owns the real flow.
      apiKey: env.ZOOMINFO_API_KEY,
      resolveApiKey: () => zoominfoToken(),
      headers: zoominfoHeaders,
      body: zoominfoMatchBody,
      extract: extractZoominfo,
    },
    fetchJson,
  );
}

export function clearbitProvider(fetchJson?: FetchJson): EnrichmentProvider {
  return vendorProvider(
    {
      name: "clearbit",
      trust: 0.7,
      costMicrosPerCall: 20_000,
      url: "https://person.clearbit.com/v2/people/find",
      apiKey: env.CLEARBIT_API_KEY,
      headers: (key) => ({ authorization: `Bearer ${key}` }),
      body: (req) => ({ email: req.subject.email, company_domain: req.subject.companyDomain }),
      extract: (json, fields) => extractFlat(json, "person", FIELD_MAP, fields),
    },
    fetchJson,
  );
}

/**
 * People Data Labs person-enrich (v5, GET + X-Api-Key). Field paths pinned against the recorded fixture
 * in providers.test.ts (PDL_HIT): the response nests everything under `data`; work_email / mobile_phone /
 * job_title are flat strings, seniority is `job_title_levels[0]`, department is `job_title_role`.
 * PDL's `likelihood` (1–10) is match confidence — not yet surfaced (extract() is a string map; the
 * confidence channel is a port follow-up).
 */
/** The PDL v5 payload → port-field mapping, exported PURE so the contract test exercises the SHIPPED map. */
export function pdlExtract(json: unknown, fields: EnrichField[]): Extracted {
  if (typeof json !== "object" || json === null) return {};
  const data = (json as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return {};
  const record = data as Record<string, unknown>;
  const out: Extracted = {};
  const map: Record<EnrichField, () => string | undefined> = {
    email: () => pick(record, "work_email"),
    phone: () => pick(record, "mobile_phone"),
    jobTitle: () => pick(record, "job_title"),
    seniorityLevel: () => {
      const levels = record.job_title_levels;
      return Array.isArray(levels) && typeof levels[0] === "string" && levels[0].length > 0
        ? levels[0]
        : undefined;
    },
    department: () => pick(record, "job_title_role"),
  };
  for (const field of fields) {
    const value = map[field]();
    if (value) out[field] = value;
  }
  return out;
}

export function pdlProvider(fetchJson?: FetchJson): EnrichmentProvider {
  return vendorProvider(
    {
      name: "pdl",
      trust: 0.75,
      costMicrosPerCall: 40_000, // $0.04 — placeholder unit cost; tuned from provider telemetry
      url: "https://api.peopledatalabs.com/v5/person/enrich",
      method: "GET",
      apiKey: env.PDL_API_KEY,
      headers: (key) => ({ "x-api-key": key }),
      query: (req) => ({
        email: req.subject.email,
        name: req.subject.fullName,
        company: req.subject.companyName ?? req.subject.companyDomain,
        profile: req.subject.linkedinUrl,
      }),
      extract: pdlExtract,
    },
    fetchJson,
  );
}

/**
 * Coresignal employee multi-source enrich (v2, GET + `apikey` header). Top-level (no `data` wrapper):
 * primary_professional_email / job_title / department / management_level — paths pinned against the
 * CORESIGNAL_HIT fixture. Declares NO contact.phone capability: the dataset has no reliable phone field,
 * and an honest capability set is what lets the v2 waterfall skip it for phone instead of paying a
 * guaranteed miss.
 */
/** Coresignal's top-level payload → port-field mapping, exported PURE for the contract test. */
export function coresignalExtract(json: unknown, fields: EnrichField[]): Extracted {
  if (typeof json !== "object" || json === null) return {};
  const record = json as Record<string, unknown>;
  const map: Record<EnrichField, string> = {
    email: "primary_professional_email",
    phone: "", // no capability — never asked, never extracted
    jobTitle: "job_title",
    seniorityLevel: "management_level",
    department: "department",
  };
  const out: Extracted = {};
  for (const field of fields) {
    const key = map[field];
    if (!key) continue;
    const value = pick(record, key);
    if (value) out[field] = value;
  }
  return out;
}

export function coresignalProvider(fetchJson?: FetchJson): EnrichmentProvider {
  return vendorProvider(
    {
      name: "coresignal",
      trust: 0.7,
      costMicrosPerCall: 35_000, // $0.035 — placeholder unit cost; tuned from provider telemetry
      url: "https://api.coresignal.com/cdapi/v2/employee_multi_source/enrich",
      method: "GET",
      apiKey: env.CORESIGNAL_API_KEY,
      headers: (key) => ({ apikey: key }),
      capabilities: ["contact.email", "contact.profile"],
      query: (req) => ({
        email: req.subject.email,
        full_name: req.subject.fullName,
        company_domain: req.subject.companyDomain,
        linkedin_url: req.subject.linkedinUrl,
      }),
      extract: coresignalExtract,
    },
    fetchJson,
  );
}

/**
 * linkedin_api person-enrich — the vendor-neutral LinkedIn-shaped source (docs/planning/
 * linkedin-source-ingestion/; payload contract = @leadwolf/types linkedinApiPersonPayloadSchema, fixtures =
 * `source plan/`). The REAL contract since the origin-fleet wiring: POST {url, include_raw:false,
 * refresh:false, engine:"auto"} to <origin>/api/linkedin/profile, walked over the provider_origins
 * FAILOVER CHAIN by core's linkedinSourceClient (per-origin x-api-key, host pinning, hardened transport).
 * No registered origin and no env fallback ⇒ permanent miss ⇒ dark — the PDL/Coresignal compliance posture
 * expressed at fleet level (HUMAN GATE: no production keys until the vendor ToS/DPA review).
 *
 * URL-KEYED, deliberately: the subject's linkedinUrl is the ONLY lookup key this vendor accepts. No URL on
 * the subject ⇒ zero-cost miss, and the waterfall cascades to the email-keyed vendors.
 *
 * The waterfall consumes only the flat port fields; the FULL payload rides out as rawPayload, which is what
 * landSourcePayload (behind LINKEDIN_SOURCE_LANDING_ENABLED) turns into Layer-0 facts. Declares NO
 * contact.phone capability: the source's contact block is reveal-gated and phones are absent from every
 * recorded fixture — an honest capability set lets the waterfall skip rather than pay a guaranteed miss.
 */
/** The linkedin_api payload → port-field mapping, exported PURE for the contract test. */
export function linkedinApiExtract(json: unknown, fields: EnrichField[]): Extracted {
  if (typeof json !== "object" || json === null) return {};
  const record = json as Record<string, unknown>;
  const contact =
    typeof record.contact === "object" && record.contact !== null
      ? (record.contact as Record<string, unknown>)
      : {};
  const position =
    typeof record.current_position === "object" && record.current_position !== null
      ? (record.current_position as Record<string, unknown>)
      : {};
  const firstEmail = (): string | undefined => {
    const primary = pick(contact, "primary_email");
    if (primary) return primary;
    const emails = contact.emails;
    return Array.isArray(emails) && typeof emails[0] === "string" && emails[0].length > 0
      ? emails[0]
      : undefined;
  };
  const map: Record<EnrichField, () => string | undefined> = {
    email: firstEmail,
    phone: () => undefined, // no capability — never asked, never extracted
    jobTitle: () => pick(position, "title") ?? pick(record, "headline"),
    seniorityLevel: () => undefined, // not asserted by the source; derivation stays core-side
    department: () => undefined,
  };
  const out: Extracted = {};
  for (const field of fields) {
    const value = map[field]();
    if (value) out[field] = value;
  }
  return out;
}

const LINKEDIN_API_COST_MICROS = 25_000; // $0.025 — placeholder unit cost; tuned from provider telemetry

export function linkedinApiProvider(
  fetchProfile: typeof fetchLinkedinProfile = fetchLinkedinProfile,
): EnrichmentProvider {
  return {
    name: "linkedin_api",
    capabilities: ["contact.email", "contact.profile"],
    trust: 0.8,
    estimateCostMicros: () => LINKEDIN_API_COST_MICROS,
    async enrich(req: EnrichRequest): Promise<ProviderResult> {
      const url = req.subject.linkedinUrl;
      // URL-keyed vendor: no URL, no lookup — a zero-cost miss, never a guess by name/email.
      if (!url) return { fields: [], rawPayload: null, costMicros: 0, status: "miss" };

      const result = await fetchProfile(url);
      if (result.status === "unavailable") {
        // No origin answered (fleet dark, all paused, or all failing) — zero-cost error; the breaker
        // counts it and the waterfall cascades.
        return { fields: [], rawPayload: null, costMicros: 0, status: "error" };
      }
      if (result.status === "rejected") {
        // The vendor answered and said no (unknown profile / bad url) — an honest zero-cost miss.
        return { fields: [], rawPayload: null, costMicros: 0, status: "miss" };
      }
      const extracted = linkedinApiExtract(result.payload, req.fields);
      const fields = Object.entries(extracted)
        .filter(([, v]) => typeof v === "string" && v.length > 0)
        .map(([field, value]) => ({ field: field as EnrichField, value: value as string }));
      // A successful capture is PAID whether or not the requested flat fields were present — the payload
      // still carries the full document (positions/education/skills…) into the landing via rawPayload.
      return fields.length > 0
        ? {
            fields,
            rawPayload: result.payload,
            costMicros: LINKEDIN_API_COST_MICROS,
            status: "hit",
          }
        : {
            fields: [],
            rawPayload: result.payload,
            costMicros: LINKEDIN_API_COST_MICROS,
            status: "miss",
          };
    },
  };
}

/** The configured waterfall set (order is decided by core's waterfall + workspace prefs, not array order). */
export function defaultProviders(): EnrichmentProvider[] {
  return [
    apolloProvider(),
    zoominfoProvider(),
    clearbitProvider(),
    pdlProvider(),
    coresignalProvider(),
    linkedinApiProvider(),
  ];
}
