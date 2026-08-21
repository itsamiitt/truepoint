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
      text: "Errors are returned as RFC 9457 problem details with the content type application/problem+json. The HTTP status tells you the class of failure; the `code` member names the specific one, and is the value to branch on in code — never the `title`, which is prose we may reword.",
    },
    {
      kind: "code",
      language: "json",
      source: `{
  "type": "https://truepoint.in/errors/insufficient_credits",
  "title": "Insufficient credits",
  "status": 402,
  "code": "insufficient_credits",
  "detail": "This call costs 1 credit; balance is 0.",
  "balance": 0,
  "required": 1
}`,
    },
    {
      kind: "p",
      text: "`type` is a URI: the code appended to https://truepoint.in/errors/. Some errors carry extra members beyond the standard four — insufficient_credits carries balance and required, rate_limited carries retryAfterSeconds — so you can act on the failure without a second call.",
    },
    {
      kind: "note",
      tone: "info",
      text: "No error response is ever billed. That includes a rate limit and an internal failure. A no-match is not an error and is also never billed — see below. If you see credits_charged on a non-2xx response, that is a bug — report it and we will credit it back.",
    },
    {
      kind: "table",
      headers: ["Status", "Type", "What it means"],
      rows: COMMON_ERRORS.map((error) => [String(error.status), error.code, error.meaning]),
    },
    { kind: "h2", text: "A no-match is not an error at all" },
    {
      kind: "p",
      text: 'There is no error code for "we found nothing", and that is deliberate. A miss answers 200 with matched:false and charges nothing. A lookup that finds nothing is a normal outcome, not a fault, and giving it a 4xx is how integrations end up treating our coverage gaps as outages — retrying them, alerting on them, and eventually routing around a working endpoint.',
    },
    {
      kind: "p",
      text: "So branch on the `matched` field, not on a status code. Do not retry a miss: the answer will not change until the graph does.",
    },
    { kind: "h2", text: "What to retry" },
    {
      kind: "list",
      items: [
        "429 rate_limited — wait the `retryAfterSeconds` the body carries, then retry. Always safe. (The interval is in the body rather than a Retry-After header; read it from there.)",
        "500 internal — retry with exponential backoff and a cap. Always safe: nothing was charged.",
        "5xx without a problem body — treat as 500.",
        "422, 401, 403 and 402 — never retry. The request will fail identically until something on your side, or your plan, changes.",
      ],
    },
    { kind: "h2", text: "Retries are safe by construction" },
    {
      kind: "p",
      text: "Send an `Idempotency-Key` header on any billable call. If a request with that key has already succeeded, we replay the original response instead of re-executing it — so a retry after a timeout cannot double-charge you. Use a fresh key per distinct call and reuse it only for retries of that same call.",
    },
  ],
};
