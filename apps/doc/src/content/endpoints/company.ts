// company.ts — the two company endpoints. Matching is free on purpose; enrichment is the billed one.
//
// CORRECTED 2026-08-21 against the shipped implementation (ADR-0049). These are now built, so this file
// describes code rather than intent, and three things in the first draft were wrong:
//   • the paths were `/v1/...`; the service serves `/api/v1/public/...`, and everything else in the fleet
//     lives under `/api/v1` too. A docs site is not the right place to fork a URL scheme.
//   • it promised an opaque `id` ("cmp_2b81") and a `match_score`. Neither exists. The registrable DOMAIN is
//     the addressing key throughout the graph, and it is the better public identifier: stable, meaningful,
//     and not an invitation to enumerate a system-owned table by integer.
//   • a miss was documented as 404. It answers 200 with matched:false — see NO_MATCH_NOTE.

import type { Endpoint } from "../types.ts";
import { COMMON_ERRORS, NO_MATCH_NOTE } from "./shared.ts";

export const COMPANY_MATCH: Endpoint = {
  slug: "company-match",
  method: "GET",
  path: "/api/v1/public/company/match",
  title: "Match a company",
  summary:
    "Resolve a domain to a company we hold, with nothing else attached. Free, and intended to be called constantly.",
  availability: "beta",
  credits: 0,
  billing: `Free. Identity resolution is plumbing: an integration calls it on every inbound record to decide whether enriching is worth a credit, so metering it would tax the step that keeps your spend efficient while earning us almost nothing. It is rate-limited per key instead. ${NO_MATCH_NOTE}`,
  params: [
    {
      name: "domain",
      type: "string",
      required: true,
      description:
        "A registrable domain. A full URL or a leading www. is accepted and normalised — send what you have.",
    },
  ],
  returns: [
    { name: "matched", type: "boolean", description: "Whether a company was found." },
    {
      name: "company.domain",
      type: "string",
      description:
        "The canonical registrable domain. This is the identifier every other call takes.",
    },
    { name: "company.name", type: "string", description: "Canonical company name." },
    { name: "credits_charged", type: "number", description: "Always 0 for this endpoint." },
  ],
  errors: COMMON_ERRORS,
  example: {
    request: `curl "https://api.truepoint.in/api/v1/public/company/match?domain=acme.com" \\
  -H "Authorization: Bearer $TRUEPOINT_API_KEY"`,
    response: `{
  "matched": true,
  "company": { "domain": "acme.com", "name": "Acme" },
  "credits_charged": 0
}`,
  },
};

export const COMPANY_ENRICH: Endpoint = {
  slug: "company-enrich",
  method: "POST",
  path: "/api/v1/public/company/enrich",
  title: "Enrich a company",
  summary: "Return the full company record — firmographics, location, size and history.",
  availability: "beta",
  credits: 1,
  billing: `One credit on a successful match. ${NO_MATCH_NOTE} Send an Idempotency-Key header and a retried request replays the original response instead of re-executing, so a timeout cannot double-charge you.`,
  params: [
    {
      name: "domain",
      type: "string",
      required: true,
      description: "A registrable domain, normalised as for /match.",
    },
  ],
  returns: [
    { name: "matched", type: "boolean", description: "Whether a company was found." },
    { name: "company.domain", type: "string", description: "Canonical registrable domain." },
    { name: "company.name", type: "string", description: "Canonical company name." },
    { name: "company.website_url", type: "string | null", description: "Primary website." },
    { name: "company.description", type: "string | null", description: "Company description." },
    {
      name: "company.industry",
      type: "string | null",
      description: "Canonical industry label where we resolved one, otherwise the raw spelling.",
    },
    {
      name: "company.employee_count",
      type: "number | null",
      description: "Current headcount estimate.",
    },
    {
      name: "company.revenue_range",
      type: "string | null",
      description:
        "A band rather than a figure. We publish what the data supports; an exact number would imply a precision we do not have.",
    },
    {
      name: "company.ownership_type",
      type: "string | null",
      description: "Public, private, and so on.",
    },
    { name: "company.year_founded", type: "number | null", description: "Year founded." },
    { name: "company.specialties", type: "string[]", description: "Self-described specialties." },
    { name: "company.hq_country", type: "string | null", description: "Headquarters country." },
    { name: "company.hq_city", type: "string | null", description: "Headquarters city." },
    {
      name: "company.last_updated",
      type: "string",
      description:
        "ISO-8601. When the graph last changed this record — the freshness signal to decide staleness against.",
      provenance: true,
    },
    { name: "credits_charged", type: "number", description: "1 on a match, 0 on a miss." },
    { name: "credits_remaining", type: "number", description: "Your balance after this call." },
  ],
  errors: COMMON_ERRORS,
  example: {
    request: `curl -X POST https://api.truepoint.in/api/v1/public/company/enrich \\
  -H "Authorization: Bearer $TRUEPOINT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: 8f2a1c40-1f3e-4d9b-9a77-5f0c2e9b1a34" \\
  -d '{"domain":"acme.com"}'`,
    response: `{
  "matched": true,
  "company": {
    "domain": "acme.com",
    "name": "Acme",
    "website_url": "https://acme.com",
    "description": "Industrial supplies since 1948.",
    "industry": "Software",
    "employee_count": 312,
    "revenue_range": "$10M–$50M",
    "ownership_type": "private",
    "year_founded": 1948,
    "specialties": ["logistics", "fulfilment"],
    "hq_country": "IN",
    "hq_city": "Pune",
    "last_updated": "2026-08-11T09:14:22.000Z"
  },
  "credits_charged": 1,
  "credits_remaining": 4821
}`,
  },
};
