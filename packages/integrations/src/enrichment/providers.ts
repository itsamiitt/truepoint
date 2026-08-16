// providers.ts — the vendor adapters (06 §3): Apollo, ZoomInfo, Clearbit (first wave) + PDL, Coresignal
// (waterfall v2 / 0111), each a VendorSpec over the shared httpProvider shape. Endpoint payload mappings
// follow each vendor's person-enrich API; trust/cost are static waterfall inputs (hit-rate learning lands
// with telemetry, 06 §4). Keys come from config; an absent key → permanent `miss` (the adapter never
// throws on configuration) — which is also the COMPLIANCE enforcement: PDL/Coresignal ship dark until
// their DPA + sub-processor listing + ToS review are recorded and only then get a production key
// (08-compliance §10, 21 §4/§5).

import { env } from "@leadwolf/config";
import type { EnrichmentProvider } from "@leadwolf/core";
import type { EnrichField } from "@leadwolf/types";
import { type FetchJson, vendorProvider } from "./httpProvider.ts";

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

export function zoominfoProvider(fetchJson?: FetchJson): EnrichmentProvider {
  return vendorProvider(
    {
      name: "zoominfo",
      trust: 0.85,
      costMicrosPerCall: 60_000,
      url: "https://api.zoominfo.com/enrich/contact",
      apiKey: env.ZOOMINFO_API_KEY,
      headers: (key) => ({ authorization: `Bearer ${key}` }),
      body: (req) => ({
        emailAddress: req.subject.email,
        fullName: req.subject.fullName,
        companyDomain: req.subject.companyDomain,
      }),
      extract: (json, fields) => extractFlat(json, "data", FIELD_MAP, fields),
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
 * `source plan/`). GET with the key in `x-api-key`; base URL is env-supplied because the vendor is unnamed
 * until its ToS/DPA review (HUMAN GATE) — no key + no base URL ⇒ permanent miss ⇒ dark, the PDL/Coresignal
 * compliance posture. The endpoint path is pinned at vendor onboarding; `/person` is the placeholder the
 * contract test exercises.
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

export function linkedinApiProvider(fetchJson?: FetchJson): EnrichmentProvider {
  const base = env.LINKEDIN_API_BASE_URL?.replace(/\/$/, "");
  return vendorProvider(
    {
      name: "linkedin_api",
      trust: 0.8,
      costMicrosPerCall: 25_000, // $0.025 — placeholder unit cost; tuned from provider telemetry
      // A missing base URL yields an unusable https://unconfigured.invalid URL that the transport's host
      // allowlist rejects as a zero-cost error — but the apiKey guard short-circuits first (miss), so the
      // URL is never fetched while the source is dark.
      url: `${base ?? "https://unconfigured.invalid"}/person`,
      method: "GET",
      apiKey: env.LINKEDIN_API_KEY,
      headers: (key) => ({ "x-api-key": key }),
      capabilities: ["contact.email", "contact.profile"],
      query: (req) => ({
        linkedin_url: req.subject.linkedinUrl,
        email: req.subject.email,
        full_name: req.subject.fullName,
        company_domain: req.subject.companyDomain,
      }),
      extract: linkedinApiExtract,
    },
    fetchJson,
  );
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
