// shared.ts — the error vocabulary every endpoint on the data API returns.
//
// It is defined once and spread into each endpoint rather than restated per page, because the failure a
// caller most needs documented is the one nobody remembers to write down.
//
// CORRECTED 2026-08-21 against the shipped platform (ADR-0049). The first draft of this file invented
// kebab-case slugs — `invalid-request`, `no-match`, `rate-limited` — that no code ever emitted. The platform
// answers RFC 9457 problem+json built by AppError.toProblemDetails, whose `code` is snake_case and whose
// `type` is that code appended to ERROR_TYPE_BASE_URL. Publishing a vocabulary the server does not speak is
// worse than publishing none: an integrator branches on it, and every branch is dead.

import type { ErrorSpec } from "../types.ts";

export const COMMON_ERRORS: readonly ErrorSpec[] = [
  {
    status: 422,
    code: "validation_error",
    meaning:
      "The request failed validation — a missing identifier, or a value we could not parse. 422 rather than 400: the request was well-formed, its contents were not.",
  },
  {
    status: 401,
    code: "invalid_token",
    meaning:
      "Missing, malformed, unknown or revoked API key. All four answer identically on purpose — the endpoint must not confirm which keys exist.",
  },
  {
    status: 403,
    code: "insufficient_scope",
    meaning: "The key is valid but was not minted with the scope this endpoint requires.",
  },
  {
    status: 402,
    code: "insufficient_credits",
    meaning:
      "The balance cannot cover this call. Nothing was charged and nothing was returned. Carries `balance` and `required`.",
  },
  {
    status: 429,
    code: "rate_limited",
    meaning:
      "Too many requests for this key. Carries `retryAfterSeconds`. Retries are safe and are not billed.",
  },
  {
    status: 500,
    code: "internal",
    meaning: "Something failed on our side. Nothing was charged. Retry with backoff.",
  },
];

/** The `type` member is the code appended to this base — e.g. `https://truepoint.in/errors/rate_limited`. */
export const ERROR_TYPE_BASE = "https://truepoint.in/errors/";

/**
 * A no-match is NOT an error and does not appear above.
 *
 * The endpoints answer `200 { "matched": false, "company": null, "credits_charged": 0 }` when nothing meets
 * the confidence bar. A lookup that finds nothing is a normal outcome, not a fault, and giving it a 4xx is
 * how integrations end up treating our coverage gaps as outages — retrying them, alerting on them, and
 * eventually routing around a working endpoint.
 */
export const NO_MATCH_NOTE =
  "A miss answers 200 with matched:false and charges nothing — it is an outcome, not an error.";

/** The suppression note that belongs on every endpoint returning person data. Suppression is enforced at
 *  egress, not filtered in the caller's code, so a suppressed person is a no-match — not a redacted record
 *  (docs/strategy/09-compliance.md; outcome S-11). */
export const SUPPRESSION_NOTE =
  "A person who has opted out is not returned by any endpoint. The call answers as a no-match and is not billed. There is no flag to include them.";
