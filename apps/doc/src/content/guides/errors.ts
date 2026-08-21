// errors.ts — the failure vocabulary. The table is generated from the same COMMON_ERRORS the endpoint pages
// use, so the reference and this guide cannot drift apart.

import { COMMON_ERRORS } from "../endpoints/shared.ts";
import type { Guide } from "../types.ts";

export const ERRORS: Guide = {
  slug: "errors",
  title: "Errors",
  summary:
    "Every failure the API returns, in RFC 9457 problem+json — and which of them cost you credits.",
  blocks: [
    {
      kind: "p",
      text: "Errors are returned as RFC 9457 problem details with the content type application/problem+json. The HTTP status tells you the class of failure; the `type` slug in the body tells you which one specifically, and is the value to branch on in code.",
    },
    {
      kind: "code",
      language: "json",
      source: `{
  "type": "no-match",
  "title": "No record met the confidence bar",
  "status": 404,
  "detail": "No person matched name + company_domain with sufficient confidence.",
  "instance": "/v1/person/enrich"
}`,
    },
    {
      kind: "note",
      tone: "info",
      text: "No error response is ever billed. That includes a no-match, a rate limit, and an upstream outage. If you see credits_charged on a non-2xx response, that is a bug — report it and we will credit it back.",
    },
    {
      kind: "table",
      headers: ["Status", "Type", "What it means"],
      rows: COMMON_ERRORS.map((error) => [String(error.status), error.code, error.meaning]),
    },
    { kind: "h2", text: "A no-match is not an error in your code" },
    {
      kind: "p",
      text: "404 no-match is the single most common non-2xx response and it is a normal outcome, not a fault. It means the identifiers you sent did not resolve to anything above our confidence bar. Handle it as a branch, not an exception — and do not retry it, because the answer will not change until the graph does.",
    },
    { kind: "h2", text: "What to retry" },
    {
      kind: "list",
      items: [
        "429 rate-limited — retry after the `Retry-After` interval. Always safe.",
        "503 upstream-unavailable — retry with exponential backoff and a cap. Always safe.",
        "5xx without a problem body — treat as 503.",
        "400, 401, 402 and 404 — never retry. The request will fail identically until something on your side changes.",
      ],
    },
    { kind: "h2", text: "Retries are safe by construction" },
    {
      kind: "p",
      text: "Enrichment calls are idempotent: the same identifiers return the same record and are billed once per successful match, not once per attempt. A retry after a timeout cannot double-charge you.",
    },
  ],
};
