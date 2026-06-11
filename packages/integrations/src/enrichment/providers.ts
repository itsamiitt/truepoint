// providers.ts — the first-wave vendor adapters (06 §3): Apollo, ZoomInfo, Clearbit, each a VendorSpec
// over the shared httpProvider shape. Endpoint payload mappings follow each vendor's people-match API;
// trust/cost are the static waterfall inputs (hit-rate learning lands with telemetry, 06 §4). Keys come
// from config; an absent key → permanent `miss` (the adapter never throws on configuration).

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

/** The configured first-wave waterfall set (order is decided by core's waterfall, not array order). */
export function defaultProviders(): EnrichmentProvider[] {
  return [apolloProvider(), zoominfoProvider(), clearbitProvider()];
}
