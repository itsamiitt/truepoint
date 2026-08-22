// search.ts — POST /v1/search, the list-building endpoint. Cursor-paginated, billed per returned result.

import type { Endpoint } from "../types.ts";
import { COMMON_ERRORS, SUPPRESSION_NOTE } from "./shared.ts";

export const SEARCH: Endpoint = {
  slug: "search",
  method: "POST",
  path: "/api/v1/public/search",
  title: "Search people and companies",
  summary:
    "Filter the graph and page through matches. The endpoint behind list building inside your product.",
  availability: "planned",
  credits: 1,
  billing: `One credit per result actually returned. A query that matches nothing is free, and so is a page you never request. ${SUPPRESSION_NOTE} NOT CALLABLE YET, for the same reason as person enrichment: a public read of the person graph has no suppression-list coverage today.`,
  params: [
    {
      name: "entity",
      type: '"person" | "company"',
      required: true,
      description: "What the filters describe and what the results are.",
    },
    {
      name: "filters",
      type: "object",
      required: true,
      description:
        "Field predicates — industry, headcount range, country, title keywords, seniority. Unknown keys are rejected rather than ignored, so a typo fails loudly instead of quietly widening your query.",
    },
    {
      name: "limit",
      type: "number",
      required: false,
      description:
        "Results per page, 1–100. Defaults to 25. You are billed for what a page returns, so page deliberately.",
    },
    {
      name: "cursor",
      type: "string",
      required: false,
      description:
        "Opaque cursor from a previous response's `next_cursor`. Cursor paging, not offsets — results stay stable while the graph changes underneath you.",
    },
  ],
  returns: [
    {
      name: "results",
      type: "array",
      description: "Matching records, in the same shape the enrich endpoints return.",
    },
    {
      name: "next_cursor",
      type: "string | null",
      description: "Pass back as `cursor` for the next page. Null on the last page.",
    },
    {
      name: "credits_charged",
      type: "number",
      description: "Credits spent on this page. Equal to the number of results returned.",
    },
  ],
  errors: COMMON_ERRORS,
  example: {
    request: `curl -X POST https://api.truepoint.in/api/v1/public/search \\
  -H "Authorization: Bearer $TRUEPOINT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
        "entity": "company",
        "filters": { "country": "IN", "headcount_min": 50, "industry": "Software" },
        "limit": 25
      }'`,
    response: `{
  "results": [
    { "domain": "northgate.example.com", "name": "Northgate Tax Partners", "headcount": 74 }
  ],
  "next_cursor": "c2Vhcm5jaDo0Mg",
  "credits_charged": 1
}`,
  },
};
