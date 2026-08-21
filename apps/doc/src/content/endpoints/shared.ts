// shared.ts — the error vocabulary every endpoint on the data API returns.
//
// It is defined once and spread into each endpoint rather than restated per page, because the failure a
// caller most needs documented is the one nobody remembers to write down. The platform answers errors as
// RFC 9457 problem+json, so `code` here is the `type` slug that arrives in the body, not an invented name.

import type { ErrorSpec } from "../types.ts";

export const COMMON_ERRORS: readonly ErrorSpec[] = [
  {
    status: 400,
    code: "invalid-request",
    meaning:
      "The query failed validation — a missing identifier, or a combination that cannot be resolved.",
  },
  {
    status: 401,
    code: "unauthenticated",
    meaning: "Missing, malformed or revoked API key.",
  },
  {
    status: 402,
    code: "insufficient-credits",
    meaning:
      "The key's balance cannot cover this call. Nothing was charged and nothing was returned.",
  },
  {
    status: 404,
    code: "no-match",
    meaning:
      "No record met the confidence bar for the identifiers given. This is the no-match case and it is never billed.",
  },
  {
    status: 429,
    code: "rate-limited",
    meaning:
      "Too many requests. `Retry-After` carries the wait in seconds; retries are safe and are not billed.",
  },
  {
    status: 503,
    code: "upstream-unavailable",
    meaning:
      "A source needed to answer this call is down. Nothing was charged. Retry with backoff.",
  },
];

/** The suppression note that belongs on every endpoint returning person data. Suppression is enforced at
 *  egress, not filtered in the caller's code, so a suppressed person is a no-match — not a redacted record
 *  (docs/strategy/09-compliance.md; outcome S-11). */
export const SUPPRESSION_NOTE =
  "A person who has opted out is not returned by any endpoint. The call answers as a no-match and is not billed. There is no flag to include them.";
