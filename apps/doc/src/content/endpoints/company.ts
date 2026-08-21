// company.ts — the two company endpoints. Matching is free on purpose; enrichment is the billed one.

import type { Endpoint } from "../types.ts";
import { COMMON_ERRORS } from "./shared.ts";

export const COMPANY_MATCH: Endpoint = {
  slug: "company-match",
  method: "GET",
  path: "/v1/company/match",
  title: "Match a company",
  summary:
    "Resolve a domain or a name to a stable company id, with nothing else attached. Free, and intended to be called constantly.",
  availability: "planned",
  credits: 0,
  billing:
    "Free. Identity resolution is plumbing: an integration calls it on every inbound record, and metering it would distort the cost of using us at all while earning almost nothing. It is rate-limited rather than priced.",
  params: [
    {
      name: "domain",
      type: "string",
      required: false,
      description: "Primary web domain. The strongest identifier.",
    },
    {
      name: "name",
      type: "string",
      required: false,
      description:
        "Company name. Resolved fuzzily; ambiguous names return the best match with a score.",
    },
  ],
  returns: [
    { name: "id", type: "string", description: "Stable TruePoint company id." },
    { name: "name", type: "string", description: "Canonical company name." },
    { name: "domain", type: "string", description: "Primary domain." },
    {
      name: "match_score",
      type: "number",
      description:
        "0–100 confidence that this is the company you meant. Below 70, treat it as a guess.",
      provenance: true,
    },
  ],
  errors: COMMON_ERRORS,
  example: {
    request: `curl "https://api.truepoint.in/v1/company/match?domain=acme.com" \\
  -H "Authorization: Bearer $TRUEPOINT_API_KEY"`,
    response: `{ "id": "cmp_2b81", "name": "Acme", "domain": "acme.com", "match_score": 98 }`,
  },
};

export const COMPANY_ENRICH: Endpoint = {
  slug: "company-enrich",
  method: "POST",
  path: "/v1/company/enrich",
  title: "Enrich a company",
  summary:
    "Return the full company record — firmographics, locations, headcount and funding history.",
  availability: "planned",
  credits: 1,
  billing: "One credit on a successful match. A no-match costs nothing.",
  params: [
    { name: "domain", type: "string", required: false, description: "Primary web domain." },
    {
      name: "id",
      type: "string",
      required: false,
      description: "A company id previously returned by match or enrich.",
    },
  ],
  returns: [
    { name: "id", type: "string", description: "Stable TruePoint company id." },
    { name: "name", type: "string", description: "Canonical company name." },
    { name: "domain", type: "string", description: "Primary domain." },
    {
      name: "headcount",
      type: "number | null",
      description: "Current employee estimate.",
      provenance: true,
    },
    { name: "locations", type: "array", description: "Known offices, with country and region." },
    { name: "industry", type: "string | null", description: "Primary industry classification." },
    {
      name: "funding",
      type: "array",
      description: "Known funding rounds with date, stage and amount where public.",
    },
    {
      name: "field_provenance",
      type: "object",
      description: "Per-field source class, last-seen timestamp and corroboration count.",
      provenance: true,
    },
  ],
  errors: COMMON_ERRORS,
  example: {
    request: `curl -X POST https://api.truepoint.in/v1/company/enrich \\
  -H "Authorization: Bearer $TRUEPOINT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"domain":"acme.com"}'`,
    response: `{
  "id": "cmp_2b81",
  "name": "Acme",
  "domain": "acme.com",
  "headcount": 312,
  "locations": [{ "city": "Pune", "country": "IN" }],
  "industry": "Software",
  "funding": [{ "stage": "Series B", "date": "2025-11", "amount_usd": 24000000 }],
  "field_provenance": {
    "headcount": { "sources": 2, "class": "corroborated", "last_seen": "2026-08-11" }
  },
  "credits_charged": 1
}`,
  },
};
