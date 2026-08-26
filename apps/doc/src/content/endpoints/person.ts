// person.ts — POST /v1/person/enrich, the endpoint the business is priced around.

import type { Endpoint } from "../types.ts";
import { COMMON_ERRORS, SUPPRESSION_NOTE } from "./shared.ts";

export const PERSON_ENRICH: Endpoint = {
  slug: "person-enrich",
  method: "POST",
  path: "/api/v1/public/person/enrich",
  title: "Enrich a person",
  summary:
    "Resolve a partial identifier — a work email, a profile URL, or a name plus a company — to a full person record with per-field provenance.",
  availability: "planned",
  credits: 3,
  billing: `Three credits on a successful match; two more if a verified business email is requested. A no-match costs nothing. ${SUPPRESSION_NOTE} NOT CALLABLE YET, and the blocker is compliance rather than effort: a public read of the person graph has no suppression-list coverage today, so serving people before that is reconciled would risk serving someone who has opted out. The company endpoints ship first because organization facts carry no such obligation.`,
  params: [
    {
      name: "email",
      type: "string",
      required: false,
      description: "A work email address. The strongest identifier — prefer it when you have one.",
    },
    {
      name: "profile_url",
      type: "string",
      required: false,
      description: "A public professional profile URL used as an addressing key.",
    },
    {
      name: "name",
      type: "string",
      required: false,
      description:
        "Full name. Must be sent together with `company_domain` — a name alone is not resolvable.",
    },
    {
      name: "company_domain",
      type: "string",
      required: false,
      description: "The employer's primary domain, used to disambiguate a name.",
    },
    {
      name: "verify_email",
      type: "boolean",
      required: false,
      description:
        "Request a deliverability check on the returned work address. Adds two credits, and only when an address is actually returned.",
    },
  ],
  returns: [
    {
      name: "id",
      type: "string",
      description: "Stable TruePoint person id. Safe to store and re-query.",
    },
    { name: "full_name", type: "string", description: "Current full name." },
    { name: "title", type: "string", description: "Current job title.", provenance: true },
    {
      name: "company",
      type: "object",
      description: "The current employer, as a company summary object.",
    },
    {
      name: "work_email",
      type: "string | null",
      description: "Verified business email. Null when none met the confidence bar.",
      provenance: true,
    },
    {
      name: "employment_history",
      type: "array",
      description: "Prior roles with company, title and date range where known.",
    },
    {
      name: "field_provenance",
      type: "object",
      description:
        "Per-field source class, last-seen timestamp and corroboration count. Read this before acting on a field.",
      provenance: true,
    },
  ],
  errors: COMMON_ERRORS,
  example: {
    request: `curl -X POST https://api.truepoint.in/api/v1/public/person/enrich \\
  -H "Authorization: Bearer $TRUEPOINT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Priya Nair","company_domain":"northgate.example.com","verify_email":true}'`,
    response: `{
  "id": "prs_7f3a91c2",
  "full_name": "Priya Nair",
  "title": "VP Revenue Operations",
  "company": { "domain": "northgate.example.com", "name": "Northgate Tax Partners" },
  "work_email": "priya.nair@northgate.example.com",
  "employment_history": [
    { "company": "Northgate Tax Partners", "title": "VP Revenue Operations", "from": "2024-03" }
  ],
  "field_provenance": {
    "title":      { "sources": 3, "class": "corroborated", "last_seen": "2026-08-14" },
    "work_email": { "sources": 2, "class": "verified",     "last_seen": "2026-08-19" }
  },
  "credits_charged": 5
}`,
  },
};
